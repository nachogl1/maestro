use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use dashmap::DashMap;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

#[cfg(unix)]
use libc;

use super::error::PtyError;

/// Stateful UTF-8 decoder that handles split multi-byte sequences.
///
/// When reading from a PTY in 4096-byte chunks, a multi-byte UTF-8 character
/// (e.g., emoji, Nerd Font icon, CJK character) can be split across chunk
/// boundaries. Using `String::from_utf8_lossy` replaces incomplete sequences
/// with U+FFFD (�), causing garbled output.
///
/// This decoder buffers incomplete trailing sequences and prepends them to
/// the next chunk, ensuring correct UTF-8 decoding across read boundaries.
pub(crate) struct Utf8Decoder {
    /// Buffer for incomplete UTF-8 sequence (max 4 bytes for any code point).
    incomplete: Vec<u8>,
}

impl Utf8Decoder {
    /// Creates a new decoder with an empty buffer.
    pub fn new() -> Self {
        Self {
            incomplete: Vec::with_capacity(4),
        }
    }

    /// Decodes bytes into `out`, buffering incomplete trailing sequences.
    ///
    /// Appends valid UTF-8 to the caller's buffer. Invalid bytes are replaced
    /// with U+FFFD and decoding continues AFTER them — they are never
    /// buffered. (Buffering from the first invalid byte onward made a single
    /// bad byte swallow the whole remaining stream: unbounded memory growth
    /// and quadratic re-copying on any non-UTF-8 output.) Only a genuinely
    /// incomplete trailing sequence — at most 3 bytes — is kept for the next
    /// call.
    ///
    /// The common case — no carried-over bytes and a fully valid chunk — takes
    /// a fast path that allocates nothing and copies the bytes exactly once,
    /// straight into `out`.
    pub fn decode_into(&mut self, input: &[u8], out: &mut String) {
        // Fast path: nothing carried over and the whole chunk is valid UTF-8.
        // `self.incomplete` is empty on essentially every call — it only holds
        // a 1-3 byte tail when a code point straddles a read boundary.
        if self.incomplete.is_empty() {
            if let Ok(s) = std::str::from_utf8(input) {
                out.push_str(s);
                return;
            }
        }

        // Prepend any previously incomplete bytes
        let mut data = std::mem::take(&mut self.incomplete);
        data.extend_from_slice(input);

        let mut rest: &[u8] = &data;

        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    // Exact (borrowed) conversion: these bytes are certified
                    // valid UTF-8 by the error above.
                    out.push_str(&String::from_utf8_lossy(&rest[..valid]));
                    match e.error_len() {
                        Some(len) => {
                            out.push('\u{FFFD}');
                            rest = &rest[valid + len..];
                        }
                        None => {
                            // Incomplete trailing sequence — finish on the
                            // next chunk.
                            self.incomplete = rest[valid..].to_vec();
                            break;
                        }
                    }
                }
            }
        }
    }

    /// Convenience wrapper around [`Self::decode_into`] that allocates a fresh
    /// `String`. Only used by the unit tests — the hot path appends directly
    /// into the emitter's batch buffer.
    #[cfg(test)]
    pub fn decode(&mut self, input: &[u8]) -> String {
        let mut out = String::with_capacity(input.len());
        self.decode_into(input, &mut out);
        out
    }
}

/// A single PTY session with its associated resources.
struct PtySession {
    /// Writer half of the PTY master — used for stdin.
    writer: Mutex<Box<dyn Write + Send>>,
    /// Master PTY handle — used for resize operations.
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// PID of the child process (shell).
    child_pid: i32,
    /// Child handle — kept so `kill_session` can reap the process via
    /// `try_wait`/`wait`. Dropping it without waiting leaves a zombie on Unix
    /// (and `kill(pid, 0)` then reports the zombie as alive forever, forcing
    /// every close through the full 3s grace period + spurious SIGKILL).
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// Process group ID for signal delivery (Unix only). portable-pty calls
    /// setsid() on spawn, so the child becomes a session+group leader (PGID == child PID).
    /// We capture this from master.process_group_leader() for correctness.
    #[cfg(unix)]
    pgid: i32,
    /// Signal to shut down the reader thread.
    shutdown: Arc<Notify>,
    /// Handle to the dedicated reader OS thread.
    reader_handle: Mutex<Option<JoinHandle<()>>>,
}

struct Inner {
    sessions: DashMap<u32, PtySession>,
    next_id: AtomicU32,
    /// Tracks last spawn time on Windows to pace rapid consecutive spawns
    /// that may cause terminal spawning loops (Bug #76). A tokio Mutex so the
    /// guard can be held across the pacing sleep, serializing concurrent
    /// spawns instead of rejecting them.
    #[cfg(windows)]
    last_spawn_time: tokio::sync::Mutex<std::time::Instant>,
}

/// Windows ConPTY workaround: respond to a DSR (Device Status Report) cursor
/// position request (ESC[6n) found anywhere in `bytes`.
///
/// ConPTY sends this query on startup and BLOCKS all output until it receives
/// a response (ESC[{row};{col}R). xterm.js may not be mounted yet, so we
/// answer immediately to unblock it. Returns `true` if a request was found and
/// answered, so the caller can stop scanning subsequent chunks.
#[cfg(windows)]
fn handle_dsr(inner: &Inner, id: u32, bytes: &[u8]) -> bool {
    if !bytes.windows(4).any(|w| w == b"\x1b[6n") {
        return false;
    }

    log::info!(
        "PTY emitter {}: detected DSR request (ESC[6n), responding with cursor position",
        id
    );
    if let Some(session) = inner.sessions.get(&id) {
        if let Ok(mut w) = session.writer.lock() {
            let _ = w.write_all(b"\x1b[1;1R");
            let _ = w.flush();
        }
    }
    true
}

/// Owns and manages all PTY sessions for the application lifetime.
///
/// Wraps an `Arc<Inner>` so it can be cheaply cloned into Tauri's managed state
/// and shared across async command handlers without lifetime issues.
/// Each session gets a monotonically increasing ID (never reused).
#[derive(Clone)]
pub struct ProcessManager {
    inner: Arc<Inner>,
}

impl Default for ProcessManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessManager {
    /// Creates a new manager with no active sessions.
    /// Session IDs start at 1 and increment atomically.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                sessions: DashMap::new(),
                next_id: AtomicU32::new(1),
                #[cfg(windows)]
                last_spawn_time: tokio::sync::Mutex::new(std::time::Instant::now()),
            }),
        }
    }

    /// Spawns a login shell in a new PTY and returns its session ID.
    ///
    /// Uses `$SHELL` (falling back to `/bin/sh`) with `-l` for a login environment.
    /// The child process calls `setsid()` via portable-pty, making it a session
    /// leader so `kill_session` can signal the entire process group.
    /// A dedicated OS thread reads PTY output into a bounded 256-slot channel
    /// (~1 MB of 4 KB chunks), and a tokio task drains it into Tauri events
    /// named `pty-output-{id}`. If the channel fills, output is dropped and a
    /// log message is emitted to make the loss visible.
    ///
    /// # Environment Variables
    /// - `MAESTRO_SESSION_ID` is automatically set to the session ID
    /// - Additional env vars can be passed via the `env` parameter (e.g., `MAESTRO_PROJECT_HASH`)
    ///
    /// # Windows Pacing
    /// On Windows, rapid consecutive spawn calls (within 500ms) are paced —
    /// serialized with a minimum 500ms gap — to prevent terminal spawning
    /// loops (Bug #76). Rejecting them outright broke legitimate back-to-back
    /// launches ("Launch All" with Plain-mode slots spawns in tens of ms).
    pub async fn spawn_shell(
        &self,
        app_handle: AppHandle,
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
    ) -> Result<u32, PtyError> {
        // Windows spawn pacing (Bug #76). Holding the tokio lock across the
        // sleep is what serializes concurrent callers — releasing it to sleep
        // would let two callers compute the same remainder and race.
        #[cfg(windows)]
        {
            let mut last = self.inner.last_spawn_time.lock().await;
            let elapsed = last.elapsed();
            let min_gap = std::time::Duration::from_millis(500);
            if elapsed < min_gap {
                let wait = min_gap - elapsed;
                log::info!(
                    "Windows spawn pacing: delaying spawn by {}ms after previous spawn",
                    wait.as_millis()
                );
                tokio::time::sleep(wait).await;
            }
            *last = std::time::Instant::now();
        }

        let id = self
            .inner
            .next_id
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current.checked_add(1)
            })
            .map_err(|_| PtyError::id_overflow())?;

        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::spawn_failed(format!("Failed to open PTY: {e}")))?;

        // Determine the user's shell (platform-specific)
        #[cfg(unix)]
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        #[cfg(windows)]
        let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());

        let mut cmd = CommandBuilder::new(&shell);
        #[cfg(unix)]
        cmd.arg("-l"); // Login shell for proper env on Unix

        // Set TERM for proper terminal emulation on Unix.
        // xterm-256color is the standard for modern terminal emulators and enables:
        // - Proper cursor positioning and line editing
        // - 256-color support
        // - Correct handling of escape sequences
        //
        // On Windows, we don't set TERM because:
        // - Windows ConPTY handles terminal emulation internally
        // - cmd.exe/PowerShell don't use the TERM variable
        // - Setting TERM can cause shell initialization issues (Issue #93)
        #[cfg(unix)]
        cmd.env("TERM", "xterm-256color");

        // Ensure UTF-8 locale for proper multi-byte character handling.
        // macOS Terminal.app/iTerm2 set LANG before launching shells, but Tauri
        // apps launched from Finder/Dock/Spotlight don't inherit that setting.
        // Without a UTF-8 locale, zsh/bash treat CJK characters as raw bytes,
        // causing garbled display and incorrect cursor positioning.
        #[cfg(unix)]
        if std::env::var("LANG").unwrap_or_default().is_empty() {
            cmd.env("LANG", "en_US.UTF-8");
        }

        // Prevent Claude Code from thinking it's nested inside another session.
        // Maestro may have been launched from a Claude Code terminal, so strip
        // the marker env var so terminals inside Maestro can start fresh sessions.
        cmd.env_remove("CLAUDECODE");

        // Inject MAESTRO_SESSION_ID automatically (used by MCP status server)
        cmd.env("MAESTRO_SESSION_ID", id.to_string());

        // Apply any additional environment variables from caller
        if let Some(envs) = env {
            for (key, value) in envs {
                cmd.env(&key, &value);
            }
        }

        if let Some(ref dir) = cwd {
            cmd.cwd(dir);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::spawn_failed(format!("Failed to spawn shell: {e}")))?;

        let child_pid = child
            .process_id()
            .map(|pid| pid as i32)
            .ok_or_else(|| PtyError::spawn_failed("Could not obtain child PID"))?;

        // Capture process group ID before moving master into Mutex (Unix only).
        // portable-pty calls setsid() on spawn, so PGID == child PID.
        // Using the API is safer than assuming the identity holds.
        #[cfg(unix)]
        let pgid = pair.master.process_group_leader().unwrap_or(child_pid);

        // Get writer from master
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtyError::spawn_failed(format!("Failed to take PTY writer: {e}")))?;

        // Get reader from master
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PtyError::spawn_failed(format!("Failed to clone PTY reader: {e}")))?;

        let shutdown = Arc::new(Notify::new());
        let shutdown_clone = shutdown.clone();

        // Dedicated OS thread for reading PTY output.
        // Sends data through a bounded mpsc channel (~1 MB of 4 KB chunks) to a
        // tokio task that emits Tauri events.
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);

        // Shutdown mechanism: dropping the master/writer FDs closes the PTY
        // file descriptor, which causes the blocking `reader.read()` call
        // below to return `Ok(0)` (EOF). This is the primary way the reader
        // thread terminates — no explicit signal is needed.
        let reader_handle = std::thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break, // EOF — shell exited
                        Ok(n) => {
                            // blocking_send is used because this is an OS thread, not async.
                            // If the channel is full or closed, we break out of the loop.
                            if tx.blocking_send(buf[..n].to_vec()).is_err() {
                                log::warn!(
                                    "PTY reader {id}: channel send failed, dropping {} bytes",
                                    n
                                );
                                break; // Channel full or receiver dropped
                            }
                        }
                        Err(e) => {
                            // EAGAIN/EINTR are retriable on Unix; anything else is fatal
                            #[cfg(unix)]
                            {
                                let raw = e.raw_os_error().unwrap_or(0);
                                if raw == libc::EAGAIN || raw == libc::EINTR {
                                    continue;
                                }
                            }
                            log::debug!("PTY reader {id} error: {e}");
                            break;
                        }
                    }
                }
                log::debug!("PTY reader {id} exited");
            })
            .map_err(|e| PtyError::spawn_failed(format!("Failed to spawn reader thread: {e}")))?;

        // Tokio task: drain the channel and emit Tauri events with time-based batching.
        // Accumulates decoded text and flushes every 16ms (aligned with 60fps) or when
        // the buffer exceeds 64KB, whichever comes first. This collapses bursts of small
        // PTY chunks (e.g. during `npm install` or `cargo build`) into fewer IPC events,
        // dramatically reducing frontend overhead while remaining imperceptible for typing.
        let event_name = format!("pty-output-{id}");
        let app = app_handle.clone();
        #[cfg(windows)]
        let inner_ref = self.inner.clone();
        tokio::spawn(async move {
            let mut decoder = Utf8Decoder::new();
            let mut batch_buf = String::new();
            // ConPTY only asks for the cursor position once, at startup. Once
            // answered, stop scanning every chunk for the rest of the session
            // (xterm.js is mounted by then and answers any later DSR itself,
            // with the real cursor position).
            #[cfg(windows)]
            let mut dsr_answered = false;
            const FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(16);
            const MAX_BATCH_BYTES: usize = 64 * 1024; // 64KB safety valve

            loop {
                // If the buffer is empty, wait for the first chunk (no timer needed).
                // If the buffer has data, race between more data and the flush timer.
                if batch_buf.is_empty() {
                    tokio::select! {
                        data = rx.recv() => {
                            match data {
                                Some(bytes) => {
                                    #[cfg(windows)]
                                    if !dsr_answered && handle_dsr(&inner_ref, id, &bytes) {
                                        dsr_answered = true;
                                    }
                                    decoder.decode_into(&bytes, &mut batch_buf);
                                    // Flush immediately if buffer exceeds safety valve
                                    if batch_buf.len() >= MAX_BATCH_BYTES {
                                        let _ = app.emit(&event_name, std::mem::take(&mut batch_buf));
                                    }
                                }
                                None => break, // Channel closed
                            }
                        }
                        _ = shutdown_clone.notified() => {
                            break;
                        }
                    }
                } else {
                    // Buffer has data — race between more data arriving and the flush timer
                    tokio::select! {
                        data = rx.recv() => {
                            match data {
                                Some(bytes) => {
                                    #[cfg(windows)]
                                    if !dsr_answered && handle_dsr(&inner_ref, id, &bytes) {
                                        dsr_answered = true;
                                    }
                                    decoder.decode_into(&bytes, &mut batch_buf);
                                    // Flush immediately if buffer exceeds safety valve
                                    if batch_buf.len() >= MAX_BATCH_BYTES {
                                        let _ = app.emit(&event_name, std::mem::take(&mut batch_buf));
                                    }
                                }
                                None => {
                                    // Channel closed — flush remaining data and exit
                                    if !batch_buf.is_empty() {
                                        let _ = app.emit(&event_name, std::mem::take(&mut batch_buf));
                                    }
                                    break;
                                }
                            }
                        }
                        _ = tokio::time::sleep(FLUSH_INTERVAL) => {
                            // Timer fired — flush accumulated data
                            if !batch_buf.is_empty() {
                                let _ = app.emit(&event_name, std::mem::take(&mut batch_buf));
                            }
                        }
                        _ = shutdown_clone.notified() => {
                            // Flush remaining data before shutdown
                            if !batch_buf.is_empty() {
                                let _ = app.emit(&event_name, std::mem::take(&mut batch_buf));
                            }
                            break;
                        }
                    }
                }
            }

            // Final flush for any remaining buffered data
            if !batch_buf.is_empty() {
                let _ = app.emit(&event_name, batch_buf);
            }
            log::debug!("PTY event emitter {id} exited");
        });

        // Drop the slave — the master keeps the PTY alive
        drop(pair.slave);

        let session = PtySession {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child_pid,
            child: Mutex::new(child),
            #[cfg(unix)]
            pgid,
            shutdown,
            reader_handle: Mutex::new(Some(reader_handle)),
        };

        self.inner.sessions.insert(id, session);
        #[cfg(unix)]
        log::info!("Spawned PTY session {id} (pid={child_pid}, pgid={pgid}, shell={shell})");
        #[cfg(windows)]
        log::info!("Spawned PTY session {id} (pid={child_pid}, shell={shell})");

        Ok(id)
    }

    /// Writes raw bytes to a session's PTY stdin and flushes immediately.
    ///
    /// Acquires the writer mutex; returns `WriteFailed` if the lock is poisoned
    /// (indicating a prior panic) or if the underlying write/flush fails.
    pub fn write_stdin(&self, session_id: u32, data: &str) -> Result<(), PtyError> {
        let session = self
            .inner
            .sessions
            .get(&session_id)
            .ok_or_else(|| PtyError::session_not_found(session_id))?;

        let mut writer = session
            .writer
            .lock()
            .map_err(|e| PtyError::write_failed(format!("Writer lock poisoned: {e}")))?;

        writer
            .write_all(data.as_bytes())
            .map_err(|e| PtyError::write_failed(format!("Write failed: {e}")))?;

        writer
            .flush()
            .map_err(|e| PtyError::write_failed(format!("Flush failed: {e}")))?;

        Ok(())
    }

    /// Resizes the PTY to the given dimensions, propagating SIGWINCH to the child.
    ///
    /// Pixel dimensions are always set to 0 (unused by terminal emulators).
    /// Callers should validate that rows/cols are non-zero before calling.
    pub fn resize_pty(&self, session_id: u32, rows: u16, cols: u16) -> Result<(), PtyError> {
        let session = self
            .inner
            .sessions
            .get(&session_id)
            .ok_or_else(|| PtyError::session_not_found(session_id))?;

        let master = session
            .master
            .lock()
            .map_err(|e| PtyError::resize_failed(format!("Master lock poisoned: {e}")))?;

        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::resize_failed(format!("Resize failed: {e}")))?;

        Ok(())
    }

    /// Terminates a PTY session with graceful escalation.
    ///
    /// On Unix: Sends SIGTERM to the entire process group (via negative PGID),
    /// waits up to 3 seconds for the lead process to exit, then escalates to
    /// SIGKILL if it is still alive.
    ///
    /// On Windows: Uses taskkill to terminate the process tree.
    ///
    /// After signaling, drops the master/writer FDs to EOF the reader thread,
    /// notifies the tokio event emitter to shut down, and joins the reader
    /// thread via `spawn_blocking` to avoid blocking the async runtime.
    /// The session is removed from the map before signaling, so concurrent
    /// calls with the same ID return `SessionNotFound`.
    pub async fn kill_session(&self, session_id: u32) -> Result<(), PtyError> {
        let session = self
            .inner
            .sessions
            .remove(&session_id)
            .ok_or_else(|| PtyError::session_not_found(session_id))?
            .1;

        let pid = session.child_pid;

        // Take the child handle out of the session so the process can be
        // REAPED, not just signaled. `libc::kill(pid, 0)` succeeds on a zombie
        // forever, so a poll based on it can never observe the exit — every
        // close then burns the full grace period and logs a spurious SIGKILL,
        // and the zombie lingers for the app's lifetime.
        let child = session
            .child
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        #[cfg(unix)]
        {
            let mut child = child;
            let pgid = session.pgid;

            // Send SIGTERM to the process group (negative pgid targets the group)
            let term_result = unsafe { libc::kill(-pgid, libc::SIGTERM) };
            if term_result != 0 {
                log::warn!(
                    "Failed to SIGTERM session {session_id} (pgid={pgid}): {}",
                    std::io::Error::last_os_error()
                );
            }

            // Wait up to 3 seconds for the shell to exit, reaping it as soon
            // as it does. An Err from try_wait is treated as "gone".
            let exited = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                loop {
                    match child.try_wait() {
                        Ok(None) => {
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        }
                        Ok(Some(_)) | Err(_) => return,
                    }
                }
            })
            .await;

            if exited.is_err() {
                // Still alive after grace period — SIGKILL the process group
                let kill_result = unsafe { libc::kill(-pgid, libc::SIGKILL) };
                if kill_result != 0 {
                    log::warn!(
                        "Failed to SIGKILL session {session_id} (pgid={pgid}): {}",
                        std::io::Error::last_os_error()
                    );
                }
                log::warn!("Session {session_id} (pid={pid}, pgid={pgid}) required SIGKILL");

                // Reap the SIGKILLed shell so it doesn't linger as a zombie.
                let _ = tokio::time::timeout(std::time::Duration::from_secs(1), async {
                    loop {
                        match child.try_wait() {
                            Ok(None) => {
                                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            }
                            Ok(Some(_)) | Err(_) => return,
                        }
                    }
                })
                .await;
            }
        }

        #[cfg(windows)]
        {
            use super::windows_process::TokioCommandExt;
            use tokio::process::Command;
            // Use taskkill to terminate process tree. Async spawn: taskkill
            // takes ~1.2s to return on this platform, and a blocking spawn
            // here stalls a whole runtime worker (kill_all_sessions runs
            // several of these at once).
            let result = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .hide_console_window()
                .output()
                .await;

            if let Err(e) = result {
                log::warn!("Failed to taskkill session {session_id} (pid={pid}): {e}");
            }

            // Release the process handle off the async runtime (wait() blocks;
            // taskkill /F above makes it near-instant).
            let mut child = child;
            let _ = tokio::task::spawn_blocking(move || {
                let _ = child.wait();
            })
            .await;
        }

        // Signal the tokio event emitter to shut down
        session.shutdown.notify_one();

        // Drop the master and writer first — this closes the PTY fd,
        // which causes the reader thread to get EOF and exit.
        drop(session.writer);
        drop(session.master);

        // Join the reader thread off the async runtime to avoid blocking tokio
        let reader_handle = session
            .reader_handle
            .lock()
            .map_err(|e| log::warn!("Reader handle lock poisoned during cleanup: {e}"))
            .ok()
            .and_then(|mut h| h.take());

        if let Some(handle) = reader_handle {
            let _ = tokio::task::spawn_blocking(move || handle.join()).await;
        }

        log::info!("Killed PTY session {session_id}");
        Ok(())
    }

    /// PIDs of every shell this manager spawned and still tracks.
    ///
    /// Used by the Processes sidebar to badge OS processes that descend from
    /// a Maestro-owned terminal.
    pub fn tracked_pids(&self) -> Vec<i32> {
        self.inner
            .sessions
            .iter()
            .map(|entry| entry.value().child_pid)
            .collect()
    }

    /// PID of the shell backing `session_id`, if that session is still
    /// tracked. Used by the Samurai watchdog to anchor its claude-descendant
    /// liveness check.
    pub fn session_pid(&self, session_id: u32) -> Option<i32> {
        self.inner
            .sessions
            .get(&session_id)
            .map(|s| s.value().child_pid)
    }

    /// Number of live PTY sessions currently tracked, across all projects.
    pub fn session_count(&self) -> usize {
        self.inner.sessions.len()
    }

    /// Kills all active PTY sessions.
    ///
    /// This is used to clean up orphaned sessions when the frontend reloads.
    /// Returns the number of sessions that were killed.
    ///
    /// Kills run concurrently, at most `MAX_CONCURRENT_KILLS` in flight. Each
    /// kill costs ~1.2s (taskkill on Windows, the SIGTERM grace poll on Unix),
    /// so a serial loop made quitting with a dozen terminals take ~15s. The
    /// cap keeps a 30-terminal quit from forking 30 processes at once.
    pub async fn kill_all_sessions(&self) -> Result<u32, PtyError> {
        const MAX_CONCURRENT_KILLS: usize = 8;

        let session_ids: Vec<u32> = self
            .inner
            .sessions
            .iter()
            .map(|entry| *entry.key())
            .collect();

        let count = session_ids.len() as u32;
        log::info!("Killing all {} PTY sessions", count);

        let mut pending = session_ids.into_iter();
        let mut tasks = tokio::task::JoinSet::new();

        loop {
            // Top the in-flight set back up to the concurrency cap.
            while tasks.len() < MAX_CONCURRENT_KILLS {
                match pending.next() {
                    Some(id) => {
                        let manager = self.clone();
                        tasks.spawn(async move {
                            if let Err(e) = manager.kill_session(id).await {
                                log::warn!("Failed to kill session {}: {}", id, e);
                            }
                        });
                    }
                    None => break,
                }
            }

            // `None` means the set is empty and nothing is left to queue.
            if tasks.join_next().await.is_none() {
                break;
            }
        }

        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8Decoder;

    #[test]
    fn decode_passes_valid_utf8_through() {
        let mut d = Utf8Decoder::new();
        assert_eq!(d.decode("hello café 世界".as_bytes()), "hello café 世界");
        assert!(d.incomplete.is_empty());
    }

    #[test]
    fn decode_buffers_incomplete_trailing_sequence() {
        let mut d = Utf8Decoder::new();
        let bytes = "é".as_bytes(); // 2 bytes: 0xC3 0xA9
        assert_eq!(d.decode(&bytes[..1]), "");
        assert_eq!(d.decode(&bytes[1..]), "é");
        assert!(d.incomplete.is_empty());
    }

    #[test]
    fn decode_replaces_invalid_bytes_and_continues() {
        // Regression: an invalid byte used to push the whole remaining chunk
        // into the incomplete buffer, so nothing after it was ever emitted.
        let mut d = Utf8Decoder::new();
        let out = d.decode(b"ok\xFFrest");
        assert_eq!(out, "ok\u{FFFD}rest");
        assert!(d.incomplete.is_empty());
    }

    #[test]
    fn decode_does_not_accumulate_on_binary_stream() {
        // Regression: latin-1/binary streams grew the buffer by ~chunk size per
        // call (quadratic re-copying, output never emitted).
        let mut d = Utf8Decoder::new();
        let chunk: Vec<u8> = (0u8..=255).cycle().take(4096).collect();
        for _ in 0..50 {
            d.decode(&chunk);
            assert!(
                d.incomplete.len() <= 3,
                "incomplete buffer must stay bounded, got {}",
                d.incomplete.len()
            );
        }
    }
}
