//! Samurai launch test gate (issue #90b): a batch must not start on a red
//! test baseline. After the epic worktree exists, the launcher runs
//! `cargo test --workspace` INSIDE that worktree — bootstrapping it first
//! (`npm install` + `cargo build --release -p maestro-mcp-server`, the fresh
//! worktree contract) — and a red suite blocks the launch. The user's "Skip
//! test-suite gate" toggle is the explicit override; skipping bypasses the
//! bootstrap too.
//!
//! Progress streams to the frontend as `samurai-test-gate-event` (the
//! launcher shows "bootstrap: npm install…", "cargo test: …" with elapsed
//! time). Both the process execution and the emission are injected
//! `Arc<dyn Fn>` seams (the `SamuraiReplicator` resolver pattern), so unit
//! tests never run a real npm/cargo and never need a Tauri app handle.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::windows_process::StdCommandExt;

// Issue #106 review F2: per-step wall-clock ceilings, so a hung child can
// never strand the launch promise forever (`.output()` had no timeout).
// Deliberately generous — several times a cold worst case on this repo —
// because expiry KILLS the step: a slow-but-alive run must never be shot.

/// `npm install` in a fresh worktree: minutes on a cold cache/slow network.
pub const NPM_INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// `cargo build --release -p maestro-mcp-server`: a from-scratch release
/// compile of the whole dependency tree.
pub const MCP_BUILD_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// `cargo test --workspace`: the full suite including its own cold compile.
pub const CARGO_TEST_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// One progress tick, emitted verbatim as the `samurai-test-gate-event`
/// frontend payload.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TestGateProgress {
    /// Canonical project path — the frontend filters on it, like every
    /// other samurai channel.
    pub project: String,
    pub epic: String,
    /// Wire step name: `bootstrap_npm`, `bootstrap_mcp`, `cargo_test`,
    /// `passed`, `failed`.
    pub step: String,
    /// Human line for the launcher's progress row.
    pub detail: String,
    /// Seconds since the gate started.
    pub elapsed_secs: u64,
}

/// What one gate command produced. A failing exit is DATA (`success:
/// false` + output), never a runner `Err` — that is reserved for "the
/// command could not run at all" (binary missing).
#[derive(Debug, Clone)]
pub struct GateCommandOutput {
    pub success: bool,
    /// Review F2 (issue #106): the step outlived its wall-clock ceiling and
    /// was killed. DATA like a failing exit, but surfaced as its own
    /// failure class — "may be hung" reads very differently from "is red".
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
}

/// The injectable process seam: run `program args…` in `cwd`, blocking,
/// killing the child once `timeout` expires (review F2), and report the
/// outcome. Tests inject a recorder; the app injects [`system_runner`].
pub type GateCommandRunner =
    Arc<dyn Fn(&Path, &str, &[&str], Duration) -> Result<GateCommandOutput, String> + Send + Sync>;

/// The injectable progress sink — lib-side this wraps
/// `app.emit("samurai-test-gate-event", …)`; tests collect into a Vec.
pub type GateProgressEmitter = Arc<dyn Fn(&TestGateProgress) + Send + Sync>;

/// Which stage blocked the launch — the failure classes the launcher
/// audits and surfaces distinctly (issue #90b; timeout added by #106 F2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TestGateFailureKind {
    /// The worktree could not be made testable (npm install / mcp build /
    /// no Cargo workspace / cargo itself unrunnable).
    Bootstrap,
    /// The suite ran and is red.
    RedSuite,
    /// A step outlived its wall-clock ceiling and was killed — the suite
    /// may be hung, which is neither "red" nor "unrunnable".
    TimedOut,
}

impl TestGateFailureKind {
    /// Wire name for the audit row's `details.phase`.
    pub fn as_str(&self) -> &'static str {
        match self {
            TestGateFailureKind::Bootstrap => "bootstrap",
            TestGateFailureKind::RedSuite => "red_suite",
            TestGateFailureKind::TimedOut => "timed_out",
        }
    }
}

/// Why the gate blocked the launch. `message` is the user-facing error the
/// Launch tab shows (it carries the failing summary lines).
#[derive(Debug, Clone)]
pub struct TestGateFailure {
    pub kind: TestGateFailureKind,
    pub message: String,
}

/// The gate: an injected runner + progress sink, `Clone`-cheap (two Arcs).
#[derive(Clone)]
pub struct SamuraiTestGate {
    runner: GateCommandRunner,
    emit: GateProgressEmitter,
}

impl SamuraiTestGate {
    pub fn new(runner: GateCommandRunner, emit: GateProgressEmitter) -> Self {
        Self { runner, emit }
    }

    /// Runs bootstrap + `cargo test --workspace` in `worktree` on the
    /// blocking pool (npm install + a full compile + suite can take many
    /// minutes — never on a runtime worker). `Err` = launch blocked.
    pub async fn run(
        &self,
        project: &str,
        epic: &str,
        worktree: &Path,
    ) -> Result<(), TestGateFailure> {
        let runner = self.runner.clone();
        let emit = self.emit.clone();
        let project = project.to_string();
        let epic = epic.to_string();
        let worktree = worktree.to_path_buf();
        tokio::task::spawn_blocking(move || run_gate(&runner, &emit, &project, &epic, &worktree))
            .await
            .map_err(|e| TestGateFailure {
                kind: TestGateFailureKind::Bootstrap,
                message: format!("launch blocked: the test-gate task failed: {e}"),
            })?
    }
}

/// The real runner: spawn + deadline poll (review F2, issue #106 — the
/// previous `.output()` had no timeout, so a hung cargo test stranded the
/// launch promise forever and leaked the child). Output is drained on
/// reader threads (a full pipe would deadlock a chatty child); on expiry
/// the child's whole process tree is killed and the result comes back as
/// `timed_out` DATA, like a failing exit. On Windows everything goes
/// through `cmd /C` — npm is a `.cmd` shim that `CreateProcess` cannot
/// spawn directly (the `ai_runner` claude-spawn precedent) — and the
/// console window is hidden as everywhere else.
pub fn system_runner() -> GateCommandRunner {
    Arc::new(|cwd, program, args, timeout| {
        let mut cmd = if cfg!(windows) {
            let mut c = std::process::Command::new("cmd");
            c.arg("/C").arg(program).args(args);
            c
        } else {
            let mut c = std::process::Command::new(program);
            c.args(args);
            c
        };
        let mut child = cmd
            .current_dir(cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .hide_console_window()
            .spawn()
            .map_err(|e| format!("could not run {program}: {e}"))?;
        let stdout = drain_to_string(child.stdout.take());
        let stderr = drain_to_string(child.stderr.take());

        // try_wait poll, the `git/runner.rs` precedent: 250ms granularity
        // is invisible next to ceilings measured in minutes.
        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() >= deadline => {
                    kill_child_tree(&mut child);
                    let _ = child.wait();
                    break None;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(250)),
                Err(e) => {
                    kill_child_tree(&mut child);
                    let _ = child.wait();
                    return Err(format!("could not wait on {program}: {e}"));
                }
            }
        };
        Ok(GateCommandOutput {
            success: status.map(|s| s.success()).unwrap_or(false),
            timed_out: status.is_none(),
            stdout: stdout.join().unwrap_or_default(),
            stderr: stderr.join().unwrap_or_default(),
        })
    })
}

/// Reads one child pipe to the end on its own thread — both pipes must be
/// drained concurrently or a chatty child fills one and deadlocks.
fn drain_to_string<R: std::io::Read + Send + 'static>(
    pipe: Option<R>,
) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

/// Kills the gate child AND its descendants. On Windows the child is
/// `cmd /C …`, so a bare kill would orphan the actual npm/cargo tree —
/// `taskkill /T /F` (the `process_manager` precedent) takes the whole tree;
/// elsewhere the direct child is npm/cargo itself.
fn kill_child_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .hide_console_window()
            .output();
    }
    let _ = child.kill();
}

/// The whole gate, synchronously (callers wrap in `spawn_blocking`).
/// Step order: detect the cargo workspace → `npm install` (only when a
/// `package.json` exists) → `cargo build --release -p maestro-mcp-server`
/// (only when that member exists) → `cargo test --workspace`.
fn run_gate(
    runner: &GateCommandRunner,
    emit: &GateProgressEmitter,
    project: &str,
    epic: &str,
    worktree: &Path,
) -> Result<(), TestGateFailure> {
    let started = Instant::now();
    let progress = |step: &str, detail: &str| {
        emit(&TestGateProgress {
            project: project.to_string(),
            epic: epic.to_string(),
            step: step.to_string(),
            detail: detail.to_string(),
            elapsed_secs: started.elapsed().as_secs(),
        });
    };
    let fail = |kind: TestGateFailureKind, message: String| {
        progress("failed", &message);
        Err(TestGateFailure { kind, message })
    };
    // Review F2 (issue #106): a killed-on-expiry step is its own failure
    // class — the suite may be hung, not red.
    let timeout_fail = |step: &str, timeout: Duration| {
        fail(
            TestGateFailureKind::TimedOut,
            format!(
                "launch blocked: `{step}` timed out after {} min and was killed — the suite \
                 may be hung (fix it, or tick \"Skip test-suite gate\" to override)",
                timeout.as_secs() / 60
            ),
        )
    };

    // Where `cargo test --workspace` runs: the worktree root when it holds
    // the workspace manifest (maestro's layout), else `src-tauri` (plain
    // Tauri layout). Neither → the gate cannot assert a green baseline;
    // blocked with the skip toggle named as the way out.
    let cargo_dir = if worktree.join("Cargo.toml").is_file() {
        worktree.to_path_buf()
    } else if worktree.join("src-tauri").join("Cargo.toml").is_file() {
        worktree.join("src-tauri")
    } else {
        return fail(
            TestGateFailureKind::Bootstrap,
            "launch blocked: no Cargo.toml found in the epic worktree — the test gate cannot \
             run `cargo test --workspace`; tick \"Skip test-suite gate\" if this project has \
             no Rust workspace"
                .to_string(),
        );
    };

    // Bootstrap 1: npm install (fresh worktrees have no node_modules, and
    // the suite's build script needs them). Only when the project is an
    // npm project at all.
    if worktree.join("package.json").is_file() {
        progress("bootstrap_npm", "bootstrap: npm install…");
        match runner(worktree, "npm", &["install"], NPM_INSTALL_TIMEOUT) {
            Ok(out) if out.timed_out => {
                return timeout_fail("npm install", NPM_INSTALL_TIMEOUT);
            }
            Ok(out) if out.success => {}
            Ok(out) => {
                return fail(
                    TestGateFailureKind::Bootstrap,
                    format!(
                        "launch blocked: worktree bootstrap failed at `npm install` — {}",
                        output_tail(&out)
                    ),
                );
            }
            Err(e) => {
                return fail(
                    TestGateFailureKind::Bootstrap,
                    bootstrap_run_error("npm", &e),
                )
            }
        }
    }

    // Bootstrap 2: the mcp-server binary (src-tauri's build.rs copies it;
    // without it the workspace build itself warns/fails on fresh
    // worktrees). Only when the member exists in this repo.
    if worktree
        .join("maestro-mcp-server")
        .join("Cargo.toml")
        .is_file()
    {
        progress("bootstrap_mcp", "bootstrap: building maestro-mcp-server…");
        match runner(
            &cargo_dir,
            "cargo",
            &["build", "--release", "-p", "maestro-mcp-server"],
            MCP_BUILD_TIMEOUT,
        ) {
            Ok(out) if out.timed_out => {
                return timeout_fail(
                    "cargo build --release -p maestro-mcp-server",
                    MCP_BUILD_TIMEOUT,
                );
            }
            Ok(out) if out.success => {}
            Ok(out) => {
                return fail(
                    TestGateFailureKind::Bootstrap,
                    format!(
                        "launch blocked: worktree bootstrap failed at `cargo build --release -p \
                         maestro-mcp-server` — {}",
                        output_tail(&out)
                    ),
                );
            }
            Err(e) => {
                return fail(
                    TestGateFailureKind::Bootstrap,
                    bootstrap_run_error("cargo", &e),
                )
            }
        }
    }

    // The gate itself: the full workspace suite in the epic worktree.
    progress("cargo_test", "cargo test: running the workspace suite…");
    match runner(
        &cargo_dir,
        "cargo",
        &["test", "--workspace"],
        CARGO_TEST_TIMEOUT,
    ) {
        Ok(out) if out.timed_out => timeout_fail("cargo test --workspace", CARGO_TEST_TIMEOUT),
        Ok(out) if out.success => {
            progress("passed", "test suite green");
            Ok(())
        }
        Ok(out) => fail(
            TestGateFailureKind::RedSuite,
            format!(
                "launch blocked: `cargo test --workspace` is RED in the epic worktree — {} \
                 (fix the baseline, or tick \"Skip test-suite gate\" to override)",
                failure_summary(&out.stdout, &out.stderr)
            ),
        ),
        Err(e) => fail(
            TestGateFailureKind::Bootstrap,
            bootstrap_run_error("cargo", &e),
        ),
    }
}

/// "could not run npm/cargo at all" — a bootstrap-class block, distinct
/// from a red suite.
fn bootstrap_run_error(program: &str, error: &str) -> String {
    format!("launch blocked: the test gate could not run {program} — {error}")
}

/// The failing summary line(s) of a red `cargo test` run: every
/// `test result: FAILED` line plus leading compile errors, capped; when
/// nothing matches (unexpected output shape), the tail of whichever stream
/// has content — the error must never be empty.
fn failure_summary(stdout: &str, stderr: &str) -> String {
    const MAX_LINES: usize = 5;
    let mut lines: Vec<&str> = Vec::new();
    for line in stdout.lines().chain(stderr.lines()) {
        let t = line.trim();
        if (t.starts_with("test result:") && t.contains("FAILED"))
            || t.starts_with("error[")
            || t.starts_with("error:")
        {
            lines.push(t);
            if lines.len() >= MAX_LINES {
                break;
            }
        }
    }
    if lines.is_empty() {
        let source = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        lines = source
            .lines()
            .rev()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .take(3)
            .collect();
        lines.reverse();
    }
    lines.join(" | ")
}

/// Last non-empty output lines of a failed bootstrap command.
fn output_tail(out: &GateCommandOutput) -> String {
    let source = if out.stderr.trim().is_empty() {
        &out.stdout
    } else {
        &out.stderr
    };
    let mut lines: Vec<&str> = source
        .lines()
        .rev()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(3)
        .collect();
    lines.reverse();
    if lines.is_empty() {
        "no output".to_string()
    } else {
        lines.join(" | ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use tempfile::tempdir;

    /// A runner that records `"<dir marker> program args…"` per call and
    /// answers from a per-program script (`success`, stdout, stderr).
    fn scripted_runner(
        script: Vec<(&'static str, GateCommandOutput)>,
        calls: Arc<Mutex<Vec<String>>>,
        worktree: PathBuf,
    ) -> GateCommandRunner {
        Arc::new(move |cwd, program, args, _timeout| {
            let where_marker = if cwd == worktree {
                "root".to_string()
            } else {
                cwd.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            };
            let call = format!("{where_marker}: {program} {}", args.join(" "));
            calls.lock().unwrap().push(call);
            for (prefix, output) in &script {
                if format!("{program} {}", args.join(" ")).starts_with(prefix) {
                    return Ok(output.clone());
                }
            }
            Ok(ok_output())
        })
    }

    fn ok_output() -> GateCommandOutput {
        GateCommandOutput {
            success: true,
            timed_out: false,
            stdout: String::new(),
            stderr: String::new(),
        }
    }

    fn failed_output(stdout: &str, stderr: &str) -> GateCommandOutput {
        GateCommandOutput {
            success: false,
            timed_out: false,
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
        }
    }

    /// A step the runner killed on expiry (review F2).
    fn timed_out_output() -> GateCommandOutput {
        GateCommandOutput {
            success: false,
            timed_out: true,
            stdout: "running 42 tests\n".to_string(),
            stderr: String::new(),
        }
    }

    fn collecting_emitter() -> (GateProgressEmitter, Arc<Mutex<Vec<TestGateProgress>>>) {
        let sink: Arc<Mutex<Vec<TestGateProgress>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_rec = sink.clone();
        (
            Arc::new(move |p: &TestGateProgress| sink_rec.lock().unwrap().push(p.clone())),
            sink,
        )
    }

    fn steps(sink: &Arc<Mutex<Vec<TestGateProgress>>>) -> Vec<String> {
        sink.lock()
            .unwrap()
            .iter()
            .map(|p| p.step.clone())
            .collect()
    }

    #[tokio::test]
    async fn test_green_gate_runs_bootstrap_then_suite_in_order() {
        // Maestro layout: workspace manifest + package.json + mcp member at
        // the worktree root → all three steps, npm at the root, cargo in
        // the root workspace, progress streamed per step.
        let wt = tempdir().unwrap();
        std::fs::write(wt.path().join("Cargo.toml"), "[workspace]\n").unwrap();
        std::fs::write(wt.path().join("package.json"), "{}").unwrap();
        std::fs::create_dir_all(wt.path().join("maestro-mcp-server")).unwrap();
        std::fs::write(
            wt.path().join("maestro-mcp-server").join("Cargo.toml"),
            "[package]\n",
        )
        .unwrap();

        let calls = Arc::new(Mutex::new(Vec::new()));
        let runner = scripted_runner(vec![], calls.clone(), wt.path().to_path_buf());
        let (emit, sink) = collecting_emitter();
        let gate = SamuraiTestGate::new(runner, emit);

        gate.run("C:/git/proj", "#38", wt.path()).await.unwrap();

        assert_eq!(
            *calls.lock().unwrap(),
            vec![
                "root: npm install".to_string(),
                "root: cargo build --release -p maestro-mcp-server".to_string(),
                "root: cargo test --workspace".to_string(),
            ]
        );
        assert_eq!(
            steps(&sink),
            vec!["bootstrap_npm", "bootstrap_mcp", "cargo_test", "passed"]
        );
        // Every tick carries the identity the frontend filters on.
        let first = sink.lock().unwrap()[0].clone();
        assert_eq!(first.project, "C:/git/proj");
        assert_eq!(first.epic, "#38");
        assert!(first.detail.contains("npm install"));
    }

    #[tokio::test]
    async fn test_bootstrap_steps_are_conditional_and_cargo_dir_falls_back() {
        // Plain Tauri layout: no root Cargo.toml, no package.json, no mcp
        // member — only the suite runs, inside src-tauri.
        let wt = tempdir().unwrap();
        std::fs::create_dir_all(wt.path().join("src-tauri")).unwrap();
        std::fs::write(
            wt.path().join("src-tauri").join("Cargo.toml"),
            "[package]\n",
        )
        .unwrap();

        let calls = Arc::new(Mutex::new(Vec::new()));
        let runner = scripted_runner(vec![], calls.clone(), wt.path().to_path_buf());
        let (emit, sink) = collecting_emitter();
        let gate = SamuraiTestGate::new(runner, emit);

        gate.run("C:/git/proj", "#38", wt.path()).await.unwrap();

        assert_eq!(
            *calls.lock().unwrap(),
            vec!["src-tauri: cargo test --workspace".to_string()]
        );
        assert_eq!(steps(&sink), vec!["cargo_test", "passed"]);
    }

    #[tokio::test]
    async fn test_no_cargo_workspace_blocks_without_running_anything() {
        let wt = tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let runner = scripted_runner(vec![], calls.clone(), wt.path().to_path_buf());
        let (emit, sink) = collecting_emitter();
        let gate = SamuraiTestGate::new(runner, emit);

        let err = gate.run("C:/git/proj", "#38", wt.path()).await.unwrap_err();
        assert_eq!(err.kind, TestGateFailureKind::Bootstrap);
        assert!(err.message.contains("no Cargo.toml"), "{}", err.message);
        assert!(err.message.contains("Skip test-suite gate"));
        assert!(calls.lock().unwrap().is_empty(), "nothing ran");
        assert_eq!(steps(&sink), vec!["failed"]);
    }

    #[tokio::test]
    async fn test_red_suite_blocks_with_the_failing_summary_lines() {
        let wt = tempdir().unwrap();
        std::fs::write(wt.path().join("Cargo.toml"), "[workspace]\n").unwrap();

        let calls = Arc::new(Mutex::new(Vec::new()));
        let runner = scripted_runner(
            vec![(
                "cargo test",
                failed_output(
                    "running 42 tests\ntest foo ... FAILED\n\
                     test result: FAILED. 40 passed; 2 failed; 0 ignored\n",
                    "",
                ),
            )],
            calls.clone(),
            wt.path().to_path_buf(),
        );
        let (emit, sink) = collecting_emitter();
        let gate = SamuraiTestGate::new(runner, emit);

        let err = gate.run("C:/git/proj", "#38", wt.path()).await.unwrap_err();
        assert_eq!(err.kind, TestGateFailureKind::RedSuite);
        assert!(
            err.message
                .contains("test result: FAILED. 40 passed; 2 failed"),
            "summary line must surface: {}",
            err.message
        );
        assert!(err.message.contains("Skip test-suite gate"));
        // The terminal "failed" tick carries the same message for the UI.
        let last = sink.lock().unwrap().last().unwrap().clone();
        assert_eq!(last.step, "failed");
        assert_eq!(last.detail, err.message);
    }

    #[tokio::test]
    async fn test_bootstrap_failure_blocks_before_the_suite_with_distinct_error() {
        let wt = tempdir().unwrap();
        std::fs::write(wt.path().join("Cargo.toml"), "[workspace]\n").unwrap();
        std::fs::write(wt.path().join("package.json"), "{}").unwrap();

        let calls = Arc::new(Mutex::new(Vec::new()));
        let runner = scripted_runner(
            vec![(
                "npm install",
                failed_output("", "npm ERR! network timeout\n"),
            )],
            calls.clone(),
            wt.path().to_path_buf(),
        );
        let (emit, _sink) = collecting_emitter();
        let gate = SamuraiTestGate::new(runner, emit);

        let err = gate.run("C:/git/proj", "#38", wt.path()).await.unwrap_err();
        assert_eq!(err.kind, TestGateFailureKind::Bootstrap);
        assert!(err.message.contains("npm install"), "{}", err.message);
        assert!(err.message.contains("npm ERR! network timeout"));
        // The suite never ran — a broken bootstrap is not a red baseline.
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_timed_out_step_blocks_with_a_distinct_hung_suite_error() {
        // Review F2 (issue #106): a killed-on-expiry step blocks the launch
        // with its OWN failure class and a "may be hung" message — through
        // the same red-gate surface (Err + terminal "failed" progress tick).
        let wt = tempdir().unwrap();
        std::fs::write(wt.path().join("Cargo.toml"), "[workspace]\n").unwrap();

        let calls = Arc::new(Mutex::new(Vec::new()));
        let runner = scripted_runner(
            vec![("cargo test", timed_out_output())],
            calls.clone(),
            wt.path().to_path_buf(),
        );
        let (emit, sink) = collecting_emitter();
        let gate = SamuraiTestGate::new(runner, emit);

        let err = gate.run("C:/git/proj", "#38", wt.path()).await.unwrap_err();
        assert_eq!(err.kind, TestGateFailureKind::TimedOut);
        assert_eq!(err.kind.as_str(), "timed_out");
        assert!(
            err.message
                .contains("`cargo test --workspace` timed out after 30 min"),
            "{}",
            err.message
        );
        assert!(err.message.contains("may be hung"), "{}", err.message);
        assert!(err.message.contains("Skip test-suite gate"));
        // The terminal "failed" tick carries the same message for the UI.
        let last = sink.lock().unwrap().last().unwrap().clone();
        assert_eq!(last.step, "failed");
        assert_eq!(last.detail, err.message);
    }

    #[tokio::test]
    async fn test_each_step_gets_its_own_timeout_ceiling() {
        // The per-step constants reach the runner seam: npm 15 min, mcp
        // build 20 min, cargo test 30 min.
        let wt = tempdir().unwrap();
        std::fs::write(wt.path().join("Cargo.toml"), "[workspace]\n").unwrap();
        std::fs::write(wt.path().join("package.json"), "{}").unwrap();
        std::fs::create_dir_all(wt.path().join("maestro-mcp-server")).unwrap();
        std::fs::write(
            wt.path().join("maestro-mcp-server").join("Cargo.toml"),
            "[package]\n",
        )
        .unwrap();

        let recorded: Arc<Mutex<Vec<(String, Duration)>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded_rt = recorded.clone();
        let runner: GateCommandRunner = Arc::new(move |_cwd, program, args, timeout| {
            recorded_rt
                .lock()
                .unwrap()
                .push((format!("{program} {}", args.join(" ")), timeout));
            Ok(ok_output())
        });
        let gate = SamuraiTestGate::new(runner, Arc::new(|_| {}));

        gate.run("C:/git/proj", "#38", wt.path()).await.unwrap();

        assert_eq!(
            *recorded.lock().unwrap(),
            vec![
                ("npm install".to_string(), NPM_INSTALL_TIMEOUT),
                (
                    "cargo build --release -p maestro-mcp-server".to_string(),
                    MCP_BUILD_TIMEOUT
                ),
                ("cargo test --workspace".to_string(), CARGO_TEST_TIMEOUT),
            ]
        );
    }

    #[test]
    fn test_failure_summary_table() {
        // Red tests: every FAILED result line, in order.
        let s = failure_summary(
            "test result: ok. 10 passed\ntest result: FAILED. 3 passed; 1 failed\n",
            "",
        );
        assert_eq!(s, "test result: FAILED. 3 passed; 1 failed");
        // Compile errors surface too (a suite that cannot build is red).
        let s = failure_summary("", "error[E0308]: mismatched types\nwarning: unused\n");
        assert_eq!(s, "error[E0308]: mismatched types");
        // Unexpected shape: fall back to the stderr tail, never empty.
        let s = failure_summary("", "something\nwent\nvery wrong\n");
        assert_eq!(s, "something | went | very wrong");
    }
}
