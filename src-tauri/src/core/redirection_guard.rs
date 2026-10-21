//! Restart Maestro outside an inherited RedirectionGuard.
//!
//! When the MSI updater relaunches Maestro at the end of an install, the new
//! process is started by the Windows Installer service, which runs with the
//! `EnforceRedirectionTrust` process mitigation (RedirectionGuard). Process
//! mitigations are inherited by children and cannot be switched off once on,
//! so every terminal, `node`, `cmd` and `claude` Maestro starts then refuses to
//! follow directory junctions created by a normal user. npm workspaces link
//! each `node_modules/<workspace>` with a junction, so builds, typechecks and
//! tests fail in every session opened from Maestro ("untrusted mount point",
//! Node errno -4094).
//!
//! [`relaunch_if_redirection_trust_enforced`] runs first at startup: when the
//! mitigation is on, it starts Maestro again through `explorer.exe` (so the new
//! process is a child of the user's shell, as after a Start-menu launch) and
//! tells the caller to exit.

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::path::Path;
    use std::time::{Duration, SystemTime};

    type Handle = *mut c_void;

    /// `PROCESS_MITIGATION_POLICY::ProcessRedirectionTrustPolicy`.
    const PROCESS_REDIRECTION_TRUST_POLICY: i32 = 16;
    /// `EnforceRedirectionTrust` bit of `PROCESS_MITIGATION_REDIRECTION_TRUST_POLICY`.
    const ENFORCE_REDIRECTION_TRUST: u32 = 0x1;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    /// A second relaunch inside this window means the first one did not help;
    /// stop instead of looping.
    const RELAUNCH_COOLDOWN: Duration = Duration::from_secs(60);

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> Handle;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetProcessMitigationPolicy(
            process: Handle,
            policy: i32,
            buffer: *mut c_void,
            length: usize,
        ) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetShellWindow() -> *mut c_void;
        fn GetWindowThreadProcessId(window: *mut c_void, pid: *mut u32) -> u32;
    }

    /// `Some(true)` when `process` enforces redirection trust, `None` when the
    /// policy cannot be read (e.g. Windows versions without RedirectionGuard).
    fn enforces_redirection_trust(process: Handle) -> Option<bool> {
        let mut flags: u32 = 0;
        // SAFETY: `flags` is a valid 4-byte buffer, the size of the policy struct.
        let ok = unsafe {
            GetProcessMitigationPolicy(
                process,
                PROCESS_REDIRECTION_TRUST_POLICY,
                &mut flags as *mut u32 as *mut c_void,
                std::mem::size_of::<u32>(),
            )
        };
        (ok != 0).then_some(flags & ENFORCE_REDIRECTION_TRUST != 0)
    }

    /// True only when the desktop shell is known to run without the mitigation,
    /// so a process it starts will not inherit it either.
    fn shell_is_unmitigated() -> bool {
        // SAFETY: plain Win32 calls; the handle is closed before returning.
        unsafe {
            let window = GetShellWindow();
            if window.is_null() {
                return false;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(window, &mut pid);
            if pid == 0 {
                return false;
            }
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let enforced = enforces_redirection_trust(handle);
            CloseHandle(handle);
            enforced == Some(false)
        }
    }

    /// Records this relaunch; returns false when another one happened within
    /// [`RELAUNCH_COOLDOWN`].
    pub(super) fn claim_relaunch(marker: &Path) -> bool {
        let recent = std::fs::metadata(marker)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age < RELAUNCH_COOLDOWN);
        if recent {
            return false;
        }
        std::fs::write(marker, b"").is_ok()
    }

    pub fn relaunch_if_redirection_trust_enforced() -> bool {
        // SAFETY: the pseudo-handle from GetCurrentProcess needs no closing.
        if enforces_redirection_trust(unsafe { GetCurrentProcess() }) != Some(true) {
            return false;
        }
        // explorer.exe cannot forward arguments; leave argument launches alone.
        if std::env::args_os().len() > 1 || !shell_is_unmitigated() {
            return false;
        }
        let Ok(exe) = std::env::current_exe() else {
            return false;
        };
        if !claim_relaunch(&std::env::temp_dir().join("maestro-redirection-relaunch")) {
            return false;
        }
        let explorer = std::env::var_os("SystemRoot")
            .map(|root| Path::new(&root).join("explorer.exe"))
            .unwrap_or_else(|| "explorer.exe".into());
        std::process::Command::new(explorer)
            .arg(exe)
            .spawn()
            .is_ok()
    }
}

/// Windows: when this process enforces redirection trust (inherited from the
/// MSI updater's relaunch), start Maestro again through the desktop shell and
/// return true — the caller must then exit before doing anything else.
/// Returns false everywhere else, and whenever a relaunch would not help.
pub fn relaunch_if_redirection_trust_enforced() -> bool {
    #[cfg(windows)]
    {
        imp::relaunch_if_redirection_trust_enforced()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::imp;

    #[test]
    fn second_relaunch_within_cooldown_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("marker");
        assert!(imp::claim_relaunch(&marker));
        assert!(!imp::claim_relaunch(&marker));
    }
}
