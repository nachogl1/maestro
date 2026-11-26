//! Tauri build script.
//!
//! This script copies the maestro-mcp-server binary to both:
//! 1. The target directory (for dev runtime discovery via candidate [0])
//! 2. src-tauri/binaries/ with target-triple suffix (for Tauri's externalBin bundler)

use std::env;
use std::fs;
use std::path::PathBuf;

/// Every command `src/lib.rs` registers with `tauri::generate_handler!`, in the same order.
/// Declaring them makes Tauri check every call to an app command against the capabilities in
/// `capabilities/` and refuse one no capability grants. `tests/command_permissions.rs` fails
/// when this list and the registered commands disagree, so add a new command to both.
const APP_COMMANDS: &[&str] = &[
    "spawn_shell",
    "write_stdin",
    "resize_pty",
    "kill_session",
    "kill_all_sessions",
    "check_cli_available",
    "get_backend_info",
    "save_pasted_image",
    "files_list_dir",
    "files_read_preview",
    "files_open_default",
    "scratch_list",
    "scratch_create",
    "scratch_delete",
    "git_branches",
    "git_current_branch",
    "git_worktree_list",
    "git_worktree_add",
    "git_worktree_remove",
    "git_worktrees_status",
    "git_discard_file",
    "git_remove_file",
    "git_file_diff",
    "git_commit_log",
    "git_checkout_branch",
    "git_create_branch",
    "git_delete_branch",
    "git_rename_branch",
    "git_delete_remote_branch",
    "git_commit_files",
    "git_user_config",
    "git_set_user_config",
    "git_list_remotes",
    "git_add_remote",
    "git_remove_remote",
    "git_refs_for_commit",
    "git_fetch",
    "git_fetch_all",
    "git_test_remote",
    "git_set_remote_url",
    "git_get_default_branch",
    "git_set_default_branch",
    "is_git_repository",
    "is_git_worktree",
    "detect_repositories",
    "list_claude_sessions",
    "delete_claude_session",
    "list_live_agent_names",
    "rename_agent",
    "summarize_claude_session",
    "set_privacy_consent",
    "set_usage_bar_allowed",
    "load_work_journal",
    "create_work_journal_page",
    "update_work_journal_page",
    "delete_work_journal_page",
    "update_work_journal_settings",
    "work_journal_backup_now",
    "work_journal_backup_if_due",
    "work_journal_ensure_pages",
    "work_journal_run_candidates",
    "work_journal_granola_status",
    "set_work_journal_enabled",
    "restore_work_journal",
    "undo_work_journal_restore",
    "workshop_status",
    "workshop_run",
    "workshop_read",
    "work_journal_restore_state",
    "list_work_journal_candidates",
    "work_journal_pending_counts",
    "reject_work_journal_candidate",
    "accept_work_journal_candidate",
    "work_journal_generate_report",
    "work_journal_fix_spelling",
    "get_sessions",
    "create_session",
    "assign_session_branch",
    "rename_session",
    "get_sessions_for_project",
    "remove_sessions_for_project",
    "prepare_session_worktree",
    "cleanup_session_worktree",
    "get_default_worktree_base_dir",
    "has_managed_worktree",
    "get_project_mcp_servers",
    "refresh_project_mcp_servers",
    "get_session_mcp_servers",
    "set_session_mcp_servers",
    "get_session_mcp_count",
    "save_project_mcp_defaults",
    "load_project_mcp_defaults",
    "add_mcp_project",
    "write_session_mcp_config",
    "remove_session_mcp_config",
    "generate_project_hash",
    "get_custom_mcp_servers",
    "save_custom_mcp_server",
    "delete_custom_mcp_server",
    "get_mcp_status",
    "upsert_mcp_server",
    "remove_mcp_server",
    "set_mcp_server_enabled",
    "get_project_plugins",
    "refresh_project_plugins",
    "get_session_skills",
    "set_session_skills",
    "get_session_plugins",
    "set_session_plugins",
    "get_session_skills_count",
    "get_session_plugins_count",
    "save_project_skill_defaults",
    "load_project_skill_defaults",
    "save_project_plugin_defaults",
    "load_project_plugin_defaults",
    "write_session_plugin_config",
    "remove_session_plugin_config",
    "delete_skill",
    "delete_plugin",
    "save_branch_config",
    "load_branch_config",
    "load_marketplace_data",
    "get_marketplace_sources",
    "add_marketplace_source",
    "remove_marketplace_source",
    "toggle_marketplace_source",
    "refresh_marketplace",
    "refresh_all_marketplaces",
    "get_available_plugins",
    "get_installed_plugins",
    "install_marketplace_plugin",
    "uninstall_plugin",
    "is_marketplace_plugin_installed",
    "get_session_marketplace_config",
    "set_marketplace_plugin_enabled",
    "clear_session_marketplace_config",
    "check_claude_md",
    "read_claude_md",
    "write_claude_md",
    "list_context_docs",
    "read_context_doc",
    "write_context_doc",
    "get_available_fonts",
    "check_font_available",
    "get_claude_usage",
    "get_claude_account",
    "get_system_metrics",
    "check_full_disk_access",
    "list_dev_processes",
    "kill_process_tree",
    "list_docker_containers",
    "stop_docker_container",
    "github_auth_status",
    "github_list_prs",
    "github_get_pr",
    "github_pr_for_branch",
    "github_create_pr",
    "github_list_issues",
    "github_issue_links",
    "github_list_assignees",
    "github_list_labels",
    "github_update_issue_assignees",
    "github_list_discussions",
    "github_get_issue",
    "github_comment_issue",
    "github_close_issue",
    "github_reopen_issue",
    "github_get_discussion",
    "github_comment_discussion",
    "github_watchdog_set_projects",
    "export_issue_map",
    "check_for_updates",
    "download_and_install_update",
    "get_app_version",
    "open_third_party_notices",
    "write_session_hooks_config",
    "remove_session_hooks_config",
    "terminal_arm_initial_prompt",
    "inject_message",
    "load_trigger_history",
    "append_trigger_history",
    "clear_trigger_history",
    "open_terminals_save",
    "open_terminals_load",
    "open_terminals_clear",
    "samurai_cleanup_kept_worktrees",
    "terminal_shell_family",
    "take_pending_cli_path",
];

fn main() {
    // Copy MCP server binary BEFORE tauri_build::build() because
    // tauri_build validates that externalBin paths exist.
    copy_mcp_server_binary();

    // Tauri's build helper does not always invalidate the compiled Windows
    // resource (resource.lib) when only icon files change, so the embedded
    // exe icon can go stale after an icon swap. Track the bundle icons
    // explicitly so Cargo reruns this build script and rebuilds the resource.
    for icon in [
        "icons/icon.ico",
        "icons/icon.icns",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
    ] {
        println!("cargo:rerun-if-changed={}", icon);
    }

    embed_common_controls_manifest_in_tests();
    write_all_app_commands_set();
    require_third_party_notices_in_release();

    // Standard Tauri build (validates externalBin paths), plus the app's own command list so
    // Tauri generates an allow-<command> permission for each one and checks every call.
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("Tauri build failed: {error:#}");
    }
}

/// Where Tauri's build helper writes the generated app permissions (gitignored).
const AUTOGENERATED_PERMISSIONS_DIR: &str = "permissions/autogenerated";

/// The permission set the capability files grant to the app's windows.
const ALL_APP_COMMANDS_SET: &str = "all-app-commands";

/// Writes the `all-app-commands` permission set: every `allow-<command>` permission Tauri
/// generates for [`APP_COMMANDS`], so a capability grants the whole list with one entry.
fn write_all_app_commands_set() {
    let permissions: String = APP_COMMANDS
        .iter()
        .map(|command| format!("  \"allow-{}\",\n", command.replace('_', "-")))
        .collect();
    let set = format!(
        "# Automatically generated by build.rs from APP_COMMANDS - DO NOT EDIT!\n\n\
         [[set]]\n\
         identifier = \"{ALL_APP_COMMANDS_SET}\"\n\
         description = \"Allows every app command declared in build.rs.\"\n\
         permissions = [\n{permissions}]\n"
    );

    let dir = PathBuf::from(AUTOGENERATED_PERMISSIONS_DIR);
    let path = dir.join(format!("{ALL_APP_COMMANDS_SET}.toml"));
    // Rewriting an unchanged file would make Cargo rerun this script on every build.
    if fs::read_to_string(&path).ok().as_deref() == Some(set.as_str()) {
        return;
    }
    fs::create_dir_all(&dir)
        .and_then(|()| fs::write(&path, set))
        .unwrap_or_else(|e| panic!("cannot write the app permission set {path:?}: {e}"));
}

/// The third-party notices `npm run notices` writes (gitignored); the installers ship them.
const THIRD_PARTY_NOTICES: &str = "../legal/THIRD-PARTY-NOTICES.txt";

/// The committed folder that holds the notices. Watching it rather than the notices file keeps
/// Cargo from rerunning this script on every build where the file was never generated.
const LEGAL_DIR: &str = "../legal";

/// A release build is the one `tauri build` puts into the installers, so it stops when the
/// third-party notices those installers must carry are missing or empty.
fn require_third_party_notices_in_release() {
    println!("cargo:rerun-if-changed={LEGAL_DIR}");
    if env::var("PROFILE").as_deref() != Ok("release") {
        return;
    }
    let has_notices = fs::metadata(THIRD_PARTY_NOTICES).is_ok_and(|m| m.len() > 0);
    if !has_notices {
        panic!(
            "{THIRD_PARTY_NOTICES} is missing or empty: run `npm run notices` first \
             (`npm run tauri build` runs it for you)"
        );
    }
}

/// Windows application manifest asking for version 6 of the common controls, the same one
/// Tauri's build helper embeds in the app itself.
const COMMON_CONTROLS_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0"
        processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

/// Tauri's build helper embeds its manifest in the app's binaries only. Integration tests that
/// start Tauri's mock runtime need it as well: without version 6 of the common controls a
/// Windows test binary stops before `main` with STATUS_ENTRYPOINT_NOT_FOUND.
fn embed_common_controls_manifest_in_tests() {
    if env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }
    let manifest_path =
        PathBuf::from(env::var("OUT_DIR").unwrap_or_default()).join("tests-app-manifest.xml");
    if let Err(e) = fs::write(&manifest_path, COMMON_CONTROLS_MANIFEST) {
        println!(
            "cargo:warning=Failed to write the tests' Windows manifest {:?}: {}",
            manifest_path, e
        );
        return;
    }
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
        manifest_path.display()
    );
}

/// Copies the maestro-mcp-server binary from its build location to:
/// 1. The Tauri target directory (for dev runtime, found by candidate [0])
/// 2. src-tauri/binaries/ with target-triple suffix (for externalBin bundler)
fn copy_mcp_server_binary() {
    let out_dir = env::var("OUT_DIR").unwrap_or_default();
    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let target = env::var("TARGET").unwrap_or_default();

    // Determine binary name based on platform
    #[cfg(target_os = "windows")]
    let binary_name = "maestro-mcp-server.exe";
    #[cfg(not(target_os = "windows"))]
    let binary_name = "maestro-mcp-server";

    // Find the project root by traversing up from OUT_DIR
    // OUT_DIR is typically: src-tauri/target/{profile}/build/{crate}/out
    let project_root = PathBuf::from(&out_dir)
        .ancestors()
        .find(|p| p.join("maestro-mcp-server").is_dir())
        .map(|p| p.to_path_buf());

    let Some(project_root) = project_root else {
        println!(
            "cargo:warning=Could not find project root from OUT_DIR: {}",
            out_dir
        );
        return;
    };

    // Source: try multiple locations where the binary may have been built.
    // 1. target/{profile}/maestro-mcp-server (normal workspace build)
    // 2. target/release/maestro-mcp-server (explicit release build)
    // 3. target/{target}/{profile}/maestro-mcp-server (cross-compilation)
    // 4. target/{target}/release/maestro-mcp-server (cross-compilation release)
    let candidates = [
        project_root.join("target").join(&profile).join(binary_name),
        project_root
            .join("target")
            .join("release")
            .join(binary_name),
        project_root
            .join("target")
            .join(&target)
            .join(&profile)
            .join(binary_name),
        project_root
            .join("target")
            .join(&target)
            .join("release")
            .join(binary_name),
    ];

    // Pick the NEWEST existing candidate, not the first: in a debug build,
    // candidate [0] (target/debug/…) is also the copy destination below, so a
    // stale copy there would shadow a freshly rebuilt target/release binary
    // forever.
    let mcp_source = candidates
        .into_iter()
        .filter(|p| p.exists())
        .max_by_key(|p| {
            fs::metadata(p)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        })
        .unwrap_or_else(|| {
            project_root
                .join("target")
                .join("release")
                .join(binary_name)
        });

    if !mcp_source.exists() {
        println!(
            "cargo:warning=maestro-mcp-server binary not found at {:?}. Build it first with: cargo build --release -p maestro-mcp-server",
            mcp_source
        );
        return;
    }

    // Destination 1: target/{profile}/maestro-mcp-server (next to the main executable)
    // In workspace builds, the main exe is at target/{profile}/maestro.exe,
    // so place the MCP binary alongside it for find_maestro_mcp_path candidate [0].
    let target_dir = project_root.join("target").join(&profile);
    let mcp_dest = target_dir.join(binary_name);

    // Only copy if source is newer than destination (or destination doesn't exist)
    let should_copy = should_copy_file(&mcp_source, &mcp_dest);

    if should_copy {
        copy_and_set_executable(&mcp_source, &mcp_dest);
    }

    // Destination 2: src-tauri/binaries/maestro-mcp-server-{TARGET}
    // This is where Tauri's externalBin bundler looks for sidecar binaries.
    if !target.is_empty() {
        let sidecar_dir = project_root.join("src-tauri").join("binaries");
        if let Err(e) = fs::create_dir_all(&sidecar_dir) {
            println!(
                "cargo:warning=Failed to create sidecar dir {:?}: {}",
                sidecar_dir, e
            );
        } else {
            #[cfg(target_os = "windows")]
            let sidecar_name = format!("maestro-mcp-server-{}.exe", target);
            #[cfg(not(target_os = "windows"))]
            let sidecar_name = format!("maestro-mcp-server-{}", target);

            let sidecar_dest = sidecar_dir.join(&sidecar_name);
            if should_copy_file(&mcp_source, &sidecar_dest) {
                copy_and_set_executable(&mcp_source, &sidecar_dest);
            }
        }
    }

    // Tell Cargo to rerun this script if the MCP server binary changes
    // Only track existing files to avoid glob pattern errors
    if mcp_source.exists() {
        println!("cargo:rerun-if-changed={}", mcp_source.display());
    }
}

/// Check if source is newer than destination (or destination doesn't exist).
fn should_copy_file(source: &PathBuf, dest: &PathBuf) -> bool {
    if dest.exists() {
        let source_meta = fs::metadata(source).ok();
        let dest_meta = fs::metadata(dest).ok();
        match (source_meta, dest_meta) {
            (Some(s), Some(d)) => {
                s.modified()
                    .ok()
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
                    > d.modified()
                        .ok()
                        .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
            }
            _ => true,
        }
    } else {
        true
    }
}

/// Copy a file and set it executable on Unix.
fn copy_and_set_executable(source: &PathBuf, dest: &PathBuf) {
    if let Err(e) = fs::copy(source, dest) {
        println!(
            "cargo:warning=Failed to copy maestro-mcp-server from {:?} to {:?}: {}",
            source, dest, e
        );
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(mut perms) = fs::metadata(dest).map(|m| m.permissions()) {
                perms.set_mode(0o755);
                let _ = fs::set_permissions(dest, perms);
            }
        }
        println!(
            "cargo:warning=Copied maestro-mcp-server from {:?} to {:?}",
            source, dest
        );
    }
}
