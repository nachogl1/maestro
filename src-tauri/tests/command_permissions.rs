//! Checks that every backend command goes through Tauri's permission check.
//!
//! `build.rs` declares the app's own commands (`APP_COMMANDS`), so Tauri refuses any call to one
//! of them that no capability in `capabilities/` grants. These tests keep that list in step with
//! the commands registered in `src/lib.rs` and prove, through the framework's own invoke path,
//! that each app window may call every declared command while anything else is refused.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The windows the app opens: the main window, the issue map and the Work Journal pop-out.
const APP_WINDOWS: [&str; 3] = ["main", "issue-map", "work-journal"];

/// A window label no capability names.
const UNKNOWN_WINDOW: &str = "unknown-window";

/// A command name the app never declares.
const UNDECLARED_COMMAND: &str = "command_nobody_declared";

/// What the stand-in command handler answers once a call passes the permission check.
const HANDLER_REACHED: &str = "handler reached";

fn read_source(relative_path: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative_path);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

/// The lines between `start` and the first `end` after it, with `//` comments removed.
fn block_lines<'a>(source: &'a str, start: &str, end: &str, what: &str) -> Vec<&'a str> {
    let after_start = source
        .split_once(start)
        .unwrap_or_else(|| panic!("{what} not found (looked for `{start}`)"))
        .1;
    let block = after_start
        .split_once(end)
        .unwrap_or_else(|| panic!("end of {what} not found (looked for `{end}`)"))
        .0;
    block
        .lines()
        .map(|line| line.split("//").next().unwrap_or_default().trim())
        .map(|line| line.trim_end_matches(',').trim())
        .filter(|line| !line.is_empty())
        .collect()
}

/// The command names `src/lib.rs` passes to `tauri::generate_handler!`, in order.
fn registered_commands() -> Vec<String> {
    let lib = read_source("src/lib.rs");
    block_lines(
        &lib,
        "generate_handler![",
        "])",
        "the generate_handler! list",
    )
    .into_iter()
    .map(|path| path.rsplit("::").next().unwrap_or(path).to_string())
    .collect()
}

/// The command names `build.rs` declares in `APP_COMMANDS`, in order.
fn declared_commands() -> Vec<String> {
    let build_script = read_source("build.rs");
    block_lines(
        &build_script,
        "const APP_COMMANDS: &[&str] = &[",
        "];",
        "the APP_COMMANDS list in build.rs",
    )
    .into_iter()
    .map(|entry| entry.trim_matches('"').to_string())
    .collect()
}

fn duplicates(names: &[String]) -> Vec<&String> {
    let mut seen = BTreeSet::new();
    names.iter().filter(|name| !seen.insert(*name)).collect()
}

#[test]
fn declared_command_list_matches_registered_commands() {
    let registered = registered_commands();
    let declared = declared_commands();

    assert!(
        duplicates(&registered).is_empty(),
        "commands registered twice in src/lib.rs: {:?}",
        duplicates(&registered)
    );
    assert!(
        duplicates(&declared).is_empty(),
        "commands declared twice in build.rs: {:?}",
        duplicates(&declared)
    );

    let registered: BTreeSet<&String> = registered.iter().collect();
    let declared: BTreeSet<&String> = declared.iter().collect();
    let not_declared: Vec<_> = registered.difference(&declared).collect();
    let not_registered: Vec<_> = declared.difference(&registered).collect();
    assert!(
        not_declared.is_empty() && not_registered.is_empty(),
        "build.rs APP_COMMANDS and src/lib.rs generate_handler! disagree.\n\
         Registered but not declared (every call to these is refused): {not_declared:?}\n\
         Declared but not registered: {not_registered:?}"
    );
}

/// An app built with the real configuration and capabilities, whose command handler answers
/// every call that passes the permission check.
fn app_with_real_permissions() -> App<MockRuntime> {
    mock_builder()
        .invoke_handler(|invoke| {
            invoke.resolver.resolve(HANDLER_REACHED);
            true
        })
        .build(tauri::generate_context!())
        .expect("mock app builds with the real configuration")
}

fn window(app: &App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
    app.get_webview_window(label).unwrap_or_else(|| {
        WebviewWindowBuilder::new(app, label, WebviewUrl::default())
            .build()
            .unwrap_or_else(|e| panic!("cannot open window {label}: {e}"))
    })
}

/// Calls `command` from `window` the way the front end does and returns the handler's answer,
/// or the refusal.
fn call(window: &WebviewWindow<MockRuntime>, command: &str) -> Result<String, String> {
    let request = InvokeRequest {
        cmd: command.to_string(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: window.url().expect("window has an address"),
        body: InvokeBody::default(),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    get_ipc_response(window, request)
        .map(|body| {
            body.deserialize::<String>()
                .expect("handler answers a string")
        })
        .map_err(|refusal| refusal.to_string())
}

#[test]
fn every_app_window_may_call_every_declared_command() {
    let app = app_with_real_permissions();
    let declared = declared_commands();
    assert!(!declared.is_empty(), "build.rs declares no commands");

    let mut refused = Vec::new();
    for label in APP_WINDOWS {
        let window = window(&app, label);
        for command in &declared {
            if let Err(refusal) = call(&window, command) {
                refused.push(format!("{label} -> {command}: {refusal}"));
            }
        }
    }
    assert!(
        refused.is_empty(),
        "declared commands refused: {refused:#?}"
    );
}

#[test]
fn calls_no_capability_grants_are_refused() {
    let app = app_with_real_permissions();
    let declared = declared_commands();
    let some_declared_command = declared.first().expect("build.rs declares commands");

    let main_window = window(&app, "main");
    assert_eq!(
        call(&main_window, some_declared_command).as_deref(),
        Ok(HANDLER_REACHED),
        "a declared command from the main window reaches its handler"
    );
    assert!(
        call(&main_window, UNDECLARED_COMMAND).is_err(),
        "a command build.rs does not declare is refused"
    );

    let unknown_window = window(&app, UNKNOWN_WINDOW);
    assert!(
        call(&unknown_window, some_declared_command).is_err(),
        "a window no capability names may not call app commands"
    );
}
