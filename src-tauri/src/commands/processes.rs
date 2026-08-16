//! IPC commands for the sidebar "Processes" section.
//!
//! Lists dev-stack OS processes (node, vite, uvicorn, claude, ...) matched
//! against a user-editable watchlist, kills whole process trees, and surfaces
//! running Docker containers. Backed by a dedicated long-lived
//! `sysinfo::System` (same idea as `SystemMetricsState`) so per-process CPU
//! deltas are computed across successive polls.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::State;

use crate::core::process_manager::ProcessManager;
use crate::core::windows_process::TokioCommandExt;

/// Command-line substring matching only applies to watchlist entries at least
/// this long. Short entries like "go" would otherwise match unrelated command
/// lines ("google", "category", ...); they still match the executable name
/// exactly.
const MIN_CMDLINE_MATCH_LEN: usize = 4;

/// Command lines are truncated before crossing IPC — some dev servers carry
/// enormous argument lists and the sidebar only shows a snippet anyway.
const MAX_CMD_LEN: usize = 400;

/// Upper bound when walking parent chains; also breaks PID-reuse cycles.
const MAX_ANCESTRY_HOPS: usize = 64;

/// How long a listening-port scan stays fresh. A dev server's port does not
/// change second to second, so spawning `netstat`/`lsof` on every 3-second
/// poll is pure waste; one scan per 15s keeps the chips accurate enough.
const PORT_SCAN_TTL: std::time::Duration = std::time::Duration::from_secs(15);

/// Shared process probe. Wrapped in a `Mutex` so the refresh delta between
/// successive polls yields accurate per-process CPU readings; `Arc` so the
/// scan can run on the blocking pool without holding Tauri state.
pub struct ProcessScanState(pub Arc<Mutex<System>>);

impl ProcessScanState {
    /// Create the probe. CPUs are refreshed once so the CPU count is known
    /// for normalizing per-process usage to a machine-wide 0-100 scale.
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_all();
        Self(Arc::new(Mutex::new(sys)))
    }
}

impl Default for ProcessScanState {
    fn default() -> Self {
        Self::new()
    }
}

/// One OS process matched by the watchlist, returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevProcess {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    /// Executable name, lowercased, without the `.exe` suffix (e.g. "node").
    pub name: String,
    /// Full command line, space-joined and truncated to `MAX_CMD_LEN`.
    pub cmd: String,
    pub cwd: Option<String>,
    pub memory_bytes: u64,
    /// CPU usage normalized to the whole machine (0-100). 0 on the first
    /// poll — sysinfo needs two samples for a delta.
    pub cpu_percent: f32,
    pub run_time_secs: u64,
    /// True when this process descends from a Maestro-spawned terminal.
    pub is_maestro: bool,
    /// The watchlist entry that matched (drives grouping in the UI).
    pub matched: String,
    /// TCP ports this PID is currently LISTENING on, sorted ascending.
    /// Best-effort: empty when the OS port tool is unavailable or the process
    /// holds none. This is what identifies a dev server (and lets the UI flag a
    /// port-holding server that no open project owns as a likely zombie).
    pub ports: Vec<u16>,
}

/// Truncate on a char boundary — cutting mid-codepoint would panic.
fn truncate_lossy(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// Returns the watchlist entry this process matches, or `None`.
///
/// Executable-name matches are exact (on the lowercased stem). Command-line
/// matches are substring-based but restricted to entries of at least
/// `MIN_CMDLINE_MATCH_LEN` chars; the longest (most specific) command-line
/// match wins over a generic name match, so `node.exe` running vite is
/// labelled "vite" rather than "node".
fn match_watchlist(name_stem: &str, cmd_lower: &str, watchlist: &[String]) -> Option<String> {
    let name_hit = watchlist.iter().find(|e| e.as_str() == name_stem);
    let cmd_hit = watchlist
        .iter()
        .filter(|e| {
            e.len() >= MIN_CMDLINE_MATCH_LEN
                && e.as_str() != name_stem
                && cmd_lower.contains(e.as_str())
        })
        .max_by_key(|e| e.len());
    cmd_hit.or(name_hit).cloned()
}

/// Parses `netstat -ano -p TCP` output into `(pid, port)` pairs for sockets in
/// the LISTENING state. Kept pure (no I/O) so it can be unit-tested off-Windows.
///
/// Row layout: `Proto  Local Address  Foreign Address  State  PID`, e.g.
/// `  TCP    127.0.0.1:3000   0.0.0.0:0   LISTENING   5678`.
#[allow(dead_code)] // used on Windows + in tests; unused in a Unix release build
fn parse_netstat_listening(output: &str) -> Vec<(u32, u16)> {
    output
        .lines()
        .filter(|l| l.contains("LISTENING"))
        .filter_map(|l| {
            let cols: Vec<&str> = l.split_whitespace().collect();
            let local = cols.get(1)?;
            let pid: u32 = cols.last()?.parse().ok()?;
            // Local address is `host:port`; IPv6 looks like `[::]:3000`, so the
            // port is always whatever follows the final colon.
            let port: u16 = local.rsplit(':').next()?.parse().ok()?;
            Some((pid, port))
        })
        .collect()
}

/// Parses `lsof -nP -iTCP -sTCP:LISTEN` output into `(pid, port)` pairs. Pure so
/// it can be unit-tested on any platform.
///
/// Row layout: `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME`, e.g.
/// `node 5678 me 24u IPv4 0x1 0t0 TCP *:3000 (LISTEN)`. The address token
/// (`*:3000`, `[::1]:3000`, `127.0.0.1:8000`) is the first one carrying a colon.
#[allow(dead_code)] // used on Unix + in tests; unused in a Windows release build
fn parse_lsof_listening(output: &str) -> Vec<(u32, u16)> {
    output
        .lines()
        .skip(1) // header row
        .filter_map(|l| {
            let cols: Vec<&str> = l.split_whitespace().collect();
            let pid: u32 = cols.get(1)?.parse().ok()?;
            let port = cols
                .iter()
                .find(|t| t.contains(':'))
                .and_then(|t| t.rsplit(':').next())
                .and_then(|p| p.parse::<u16>().ok())?;
            Some((pid, port))
        })
        .collect()
}

/// Maps each PID to the TCP ports it is currently LISTENING on (best-effort).
///
/// Uses the OS's own tooling — `netstat` on Windows, `lsof` on Unix — instead
/// of a new dependency, mirroring how this module already shells out to
/// `taskkill`/`docker`. Any failure (tool missing, non-zero exit, parse miss)
/// degrades to an empty map, so port info is simply absent rather than fatal.
async fn listening_ports_by_pid() -> HashMap<u32, Vec<u16>> {
    #[cfg(windows)]
    let pairs: Vec<(u32, u16)> = {
        let mut cmd = tokio::process::Command::new("netstat");
        cmd.args(["-ano", "-p", "TCP"]);
        cmd.hide_console_window();
        match cmd.output().await {
            Ok(o) if o.status.success() => {
                parse_netstat_listening(&String::from_utf8_lossy(&o.stdout))
            }
            _ => Vec::new(),
        }
    };

    #[cfg(unix)]
    let pairs: Vec<(u32, u16)> = {
        let mut cmd = tokio::process::Command::new("lsof");
        cmd.args(["-nP", "-iTCP", "-sTCP:LISTEN"]);
        cmd.hide_console_window();
        match cmd.output().await {
            Ok(o) if o.status.success() => {
                parse_lsof_listening(&String::from_utf8_lossy(&o.stdout))
            }
            _ => Vec::new(),
        }
    };

    let mut map: HashMap<u32, Vec<u16>> = HashMap::new();
    for (pid, port) in pairs {
        let entry = map.entry(pid).or_default();
        if !entry.contains(&port) {
            entry.push(port);
        }
    }
    for ports in map.values_mut() {
        ports.sort_unstable();
    }
    map
}

/// A port scan plus the moment it was taken.
type PortScan = (std::time::Instant, HashMap<u32, Vec<u16>>);

/// Last port scan. `None` means "never scanned", which forces a real scan on
/// the first call — an `Instant` cannot portably be constructed far enough in
/// the past to express that.
static PORT_SCAN_CACHE: LazyLock<Mutex<Option<PortScan>>> = LazyLock::new(|| Mutex::new(None));

/// `listening_ports_by_pid` behind a `PORT_SCAN_TTL` cache.
///
/// The scan shells out to `netstat`/`lsof`, so tying it to the 3-second poll
/// rate meant a child process spawn every tick for data that barely changes.
/// The lock is only held around the map clone — never across the await.
async fn listening_ports_cached() -> HashMap<u32, Vec<u16>> {
    let fresh = PORT_SCAN_CACHE.lock().ok().and_then(|cache| match &*cache {
        Some((at, map)) if at.elapsed() < PORT_SCAN_TTL => Some(map.clone()),
        _ => None,
    });
    if let Some(map) = fresh {
        return map;
    }

    let map = listening_ports_by_pid().await;
    if let Ok(mut cache) = PORT_SCAN_CACHE.lock() {
        *cache = Some((std::time::Instant::now(), map.clone()));
    }
    map
}

/// Scans all OS processes and returns those matching the watchlist.
///
/// The watchlist comes from the frontend (persisted, user-editable). Entries
/// are trimmed and lowercased here so the matching rules are enforced in one
/// place. Maestro's own process is always excluded.
#[tauri::command]
pub async fn list_dev_processes(
    watchlist: Vec<String>,
    state: State<'_, ProcessScanState>,
    process_manager: State<'_, ProcessManager>,
) -> Result<Vec<DevProcess>, String> {
    let watchlist: Vec<String> = watchlist
        .into_iter()
        .map(|e| e.trim().to_lowercase())
        .filter(|e| !e.is_empty())
        .collect();
    if watchlist.is_empty() {
        return Ok(Vec::new());
    }

    let own_pid = sysinfo::get_current_pid().map_err(|e| e.to_string())?;

    // Scan listening ports before taking the sysinfo lock — this shells out and
    // we must not hold the mutex across it. Cached, so most polls skip the spawn.
    let ports_by_pid = listening_ports_cached().await;

    // Roots for the "spawned by Maestro" badge: the app itself plus every
    // PTY shell it launched.
    let tracked_pids = process_manager.tracked_pids();
    let sys_state = Arc::clone(&state.0);

    // The full process-table refresh (cmdline + cwd of every OS process) takes
    // long enough to stutter the UI, and this used to run inline on the main
    // thread on every 3-second poll. Keep it off the async runtime too.
    tokio::task::spawn_blocking(move || -> Result<Vec<DevProcess>, String> {
        let mut sys = sys_state
            .lock()
            .map_err(|e| format!("Process scan state poisoned: {e}"))?;

        // Both `OnlyIfNotSet` so this whole-table sweep costs no syscalls for a
        // PID already seen. sysinfo gates its entire Windows parameter pipeline
        // — OpenProcess, two NtQueryInformationProcess calls and three
        // ReadProcessMemory reads of the PEB — on *any* of cmd/environ/cwd/root
        // needing an update. One `Always` re-opens the lot for every process on
        // the machine, 20x a minute, so both have to be lazy for the gate to
        // close. `remove_dead_processes: true` drops dead PIDs, so a recycled
        // PID still gets read fresh.
        //
        // cwd is refreshed below for the watchlist matches only: it *can*
        // change (a process may chdir) and it drives row grouping, the repo
        // label and stale-process classification, so it cannot simply be
        // cached — but only a handful of PIDs are ever displayed.
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::new()
                .with_cpu()
                .with_memory()
                .with_cmd(UpdateKind::OnlyIfNotSet)
                .with_cwd(UpdateKind::OnlyIfNotSet),
        );

        let cpu_count = sys.cpus().len().max(1) as f32;

        let mut maestro_roots: HashSet<Pid> = tracked_pids
            .into_iter()
            .filter(|pid| *pid > 0)
            .map(|pid| Pid::from_u32(pid as u32))
            .collect();
        maestro_roots.insert(own_pid);

        let parent_of: HashMap<Pid, Pid> = sys
            .processes()
            .iter()
            .filter_map(|(pid, p)| p.parent().map(|pp| (*pid, pp)))
            .collect();

        let mut out = Vec::new();
        for (pid, process) in sys.processes() {
            if *pid == own_pid {
                continue;
            }

            let name_lower = process.name().to_string_lossy().to_lowercase();
            let name_stem = name_lower.strip_suffix(".exe").unwrap_or(&name_lower);

            let cmd_joined = process
                .cmd()
                .iter()
                .map(|c| c.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            let cmd_lower = cmd_joined.to_lowercase();

            let Some(matched) = match_watchlist(name_stem, &cmd_lower, &watchlist) else {
                continue;
            };

            let is_maestro = {
                let mut cur = *pid;
                let mut hops = 0;
                loop {
                    if maestro_roots.contains(&cur) {
                        break true;
                    }
                    match parent_of.get(&cur) {
                        Some(pp) if hops < MAX_ANCESTRY_HOPS && *pp != cur => {
                            cur = *pp;
                            hops += 1;
                        }
                        _ => break false,
                    }
                }
            };

            out.push(DevProcess {
                pid: pid.as_u32(),
                parent_pid: process.parent().map(|p| p.as_u32()),
                name: name_stem.to_string(),
                cmd: truncate_lossy(&cmd_joined, MAX_CMD_LEN),
                // Filled in by the targeted cwd refresh below.
                cwd: None,
                memory_bytes: process.memory(),
                cpu_percent: process.cpu_usage() / cpu_count,
                run_time_secs: process.run_time(),
                is_maestro,
                matched,
                ports: ports_by_pid.get(&pid.as_u32()).cloned().unwrap_or_default(),
            });
        }

        // Now pay for an accurate cwd, but only on the rows the UI will show —
        // typically a handful, against a table of several hundred. This is the
        // one place the expensive PEB read is worth it, and scoping it here is
        // what lets the sweep above stay syscall-free.
        if !out.is_empty() {
            let matched_pids: Vec<Pid> = out.iter().map(|p| Pid::from_u32(p.pid)).collect();
            sys.refresh_processes_specifics(
                // `false`: this pass must not prune the snapshot that
                // `kill_process_tree`'s ancestry guard later reads.
                ProcessesToUpdate::Some(&matched_pids),
                false,
                ProcessRefreshKind::new().with_cwd(UpdateKind::Always),
            );
            for dev in &mut out {
                dev.cwd = sys
                    .process(Pid::from_u32(dev.pid))
                    .and_then(|p| p.cwd())
                    .map(|p| p.to_string_lossy().into_owned());
            }
        }

        Ok(out)
    })
    .await
    .map_err(|e| format!("Process scan task failed: {e}"))?
}

/// Kills a process and its whole descendant tree.
///
/// Guards: never Maestro itself, never low-PID system processes, and never an
/// ancestor of Maestro (that would take the app down with it). The ancestry
/// check uses the last scan snapshot — best-effort, but the UI only offers
/// kill buttons on watchlist-matched rows anyway.
#[tauri::command]
pub async fn kill_process_tree(pid: u32, state: State<'_, ProcessScanState>) -> Result<(), String> {
    let own_pid = sysinfo::get_current_pid().map_err(|e| e.to_string())?;
    if pid == own_pid.as_u32() {
        return Err("Refusing to kill Maestro itself".to_string());
    }
    if pid <= 4 {
        return Err("Refusing to kill a system process".to_string());
    }

    #[cfg_attr(windows, allow(unused_variables))]
    let descendants: Vec<i32> = {
        let sys = state
            .0
            .lock()
            .map_err(|e| format!("Process scan state poisoned: {e}"))?;

        // Walk our own parent chain; killing anything on it kills the app.
        let mut cur = own_pid;
        let mut hops = 0;
        while let Some(parent) = sys.process(cur).and_then(|p| p.parent()) {
            if parent.as_u32() == pid {
                return Err("Refusing to kill an ancestor of Maestro".to_string());
            }
            if hops >= MAX_ANCESTRY_HOPS || parent == cur {
                break;
            }
            cur = parent;
            hops += 1;
        }

        // Collect the descendant tree from the snapshot (used on Unix, where
        // there is no `taskkill /T` equivalent for arbitrary PIDs).
        let root = Pid::from_u32(pid);
        let mut targets = vec![root];
        let mut frontier = vec![root];
        while let Some(cur) = frontier.pop() {
            for (child_pid, p) in sys.processes() {
                if p.parent() == Some(cur) && !targets.contains(child_pid) {
                    targets.push(*child_pid);
                    frontier.push(*child_pid);
                }
            }
        }
        targets.iter().map(|p| p.as_u32() as i32).collect()
    };

    #[cfg(windows)]
    {
        let mut cmd = tokio::process::Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
            .hide_console_window()
            .kill_on_drop(true);
        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to run taskkill: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(format!(
                "taskkill failed: {} {}",
                stdout.trim(),
                stderr.trim()
            ));
        }
    }

    #[cfg(unix)]
    {
        // SIGTERM the whole tree, give it a moment, then SIGKILL survivors.
        for t in &descendants {
            unsafe { libc::kill(*t, libc::SIGTERM) };
        }
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        for t in &descendants {
            if unsafe { libc::kill(*t, 0) } == 0 {
                unsafe { libc::kill(*t, libc::SIGKILL) };
            }
        }
    }

    log::info!("Killed process tree rooted at pid {pid}");
    Ok(())
}

/// One running Docker container, from `docker ps`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
}

/// Result of `list_docker_containers`. `available: false` means the docker
/// CLI is missing, the daemon is down, or the call timed out — the UI simply
/// hides the containers block.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerPs {
    pub available: bool,
    pub containers: Vec<DockerContainer>,
}

/// Lists running Docker containers via the docker CLI.
///
/// Containers run inside Docker Desktop's VM on Windows/macOS, so they never
/// appear in the OS process scan — the CLI is the only window into them.
#[tauri::command]
pub async fn list_docker_containers() -> Result<DockerPs, String> {
    let unavailable = DockerPs {
        available: false,
        containers: Vec::new(),
    };

    let mut cmd = tokio::process::Command::new("docker");
    cmd.args(["ps", "--format", "{{json .}}"])
        .hide_console_window()
        .kill_on_drop(true);

    let output = match tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output()).await {
        Ok(Ok(output)) => output,
        // CLI missing, or a hung daemon — treat both as "no Docker here".
        _ => return Ok(unavailable),
    };
    if !output.status.success() {
        return Ok(unavailable);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let containers = stdout
        .lines()
        .filter_map(|line| {
            let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
            let field = |k: &str| {
                v.get(k)
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string()
            };
            let id = field("ID");
            if id.is_empty() {
                return None;
            }
            Some(DockerContainer {
                id,
                name: field("Names"),
                image: field("Image"),
                status: field("Status"),
            })
        })
        .collect();

    Ok(DockerPs {
        available: true,
        containers,
    })
}

/// Stops a running Docker container by id or name.
#[tauri::command]
pub async fn stop_docker_container(id: String) -> Result<(), String> {
    // Container ids/names are strictly [A-Za-z0-9][A-Za-z0-9_.-]*; anything
    // else — especially option-like strings — is rejected before it can reach
    // the CLI as an argument.
    let valid = !id.is_empty()
        && id.len() <= 128
        && id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if !valid {
        return Err("Invalid container id".to_string());
    }

    let mut cmd = tokio::process::Command::new("docker");
    cmd.args(["stop", &id])
        .hide_console_window()
        .kill_on_drop(true);

    // `docker stop` waits up to 10s for a graceful shutdown before killing;
    // the outer timeout only covers a truly hung daemon.
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| "docker stop timed out".to_string())?
        .map_err(|e| format!("Failed to run docker stop: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("docker stop failed: {}", stderr.trim()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|e| e.to_string()).collect()
    }

    #[test]
    fn name_match_is_exact_on_stem() {
        let wl = list(&["node", "go"]);
        assert_eq!(match_watchlist("node", "", &wl).as_deref(), Some("node"));
        assert_eq!(match_watchlist("go", "", &wl).as_deref(), Some("go"));
        // "gopls" must not match the short entry "go".
        assert_eq!(match_watchlist("gopls", "", &wl), None);
    }

    #[test]
    fn short_entries_never_match_cmdline() {
        let wl = list(&["go"]);
        assert_eq!(match_watchlist("chrome", "https://google.com", &wl), None);
    }

    #[test]
    fn cmdline_match_beats_generic_name_match() {
        let wl = list(&["node", "vite"]);
        let m = match_watchlist("node", "node /repo/node_modules/vite/bin/vite.js", &wl);
        assert_eq!(m.as_deref(), Some("vite"));
    }

    #[test]
    fn netstat_parse_keeps_only_listening_rows() {
        let out = "\
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       900
  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       5678
  TCP    [::]:3000              [::]:0                 LISTENING       5678
  TCP    127.0.0.1:52000        127.0.0.1:3000         ESTABLISHED     5678
";
        let pairs = parse_netstat_listening(out);
        assert!(pairs.contains(&(900, 135)));
        assert!(pairs.contains(&(5678, 3000)));
        // Non-LISTENING rows must be ignored (would otherwise yield port 52000).
        assert!(!pairs.iter().any(|(_, port)| *port == 52000));
    }

    #[test]
    fn lsof_parse_reads_pid_and_port() {
        let out = "\
COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node     5678 me     24u  IPv4 0x1a2b      0t0  TCP *:3000 (LISTEN)
node     5678 me     25u  IPv6 0x3c4d      0t0  TCP [::1]:3000 (LISTEN)
python    999 me      6u  IPv4 0x5e6f      0t0  TCP 127.0.0.1:8000 (LISTEN)
";
        let pairs = parse_lsof_listening(out);
        assert!(pairs.contains(&(5678, 3000)));
        assert!(pairs.contains(&(999, 8000)));
    }

    #[test]
    fn longest_cmdline_match_wins() {
        let wl = list(&["uvicorn", "django"]);
        // Both present: prefer the more specific (longer) entry.
        let m = match_watchlist(
            "python",
            "python -m uvicorn django_app.asgi:application",
            &wl,
        );
        assert_eq!(m.as_deref(), Some("uvicorn"));
    }

    #[test]
    fn truncate_lossy_is_char_boundary_safe() {
        // 'é' is 2 bytes; cutting at byte 1 must not panic.
        let s = "é".repeat(10);
        let t = truncate_lossy(&s, 1);
        assert!(t.ends_with('…'));
        assert_eq!(truncate_lossy("short", 400), "short");
    }
}
