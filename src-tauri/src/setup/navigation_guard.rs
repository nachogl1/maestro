//! Keeps every app window on the app's own pages.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};
use url::Url;

/// The scheme, and host name, the framework serves the bundled app pages under.
const APP_PAGES: &str = "tauri";

/// The `about:` pages frames start on: an empty frame and an inline one.
const FRAME_PAGES: [&str; 2] = ["blank", "srcdoc"];

/// How the framework addresses the bundled app pages on a platform.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AppPageForm {
    /// Windows and Android: `http://tauri.localhost`.
    LocalhostSubdomain,
    /// Every other platform: `tauri://localhost`.
    CustomScheme,
}

impl AppPageForm {
    /// The form this build's platform uses.
    pub(crate) const CURRENT: Self = if cfg!(windows) || cfg!(target_os = "android") {
        Self::LocalhostSubdomain
    } else {
        Self::CustomScheme
    };
}

/// Whether a window may show `url`: true only for the app's own pages, in the
/// `form` the platform serves them. `dev_url` is the dev server address,
/// passed in development builds only.
pub(crate) fn is_app_address(url: &Url, form: AppPageForm, dev_url: Option<&Url>) -> bool {
    if url.scheme() == "about" {
        return FRAME_PAGES.contains(&url.path());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if dev_url.is_some_and(|dev| {
        dev.scheme() == url.scheme()
            && dev.host_str() == url.host_str()
            && dev.port_or_known_default() == url.port_or_known_default()
    }) {
        return true;
    }
    if url.port().is_some() {
        return false;
    }
    let host = url.host_str();
    match form {
        // `http` only: no window turns on the https scheme setting. Turning it
        // on for a window means updating this guard in the same change.
        AppPageForm::LocalhostSubdomain => {
            url.scheme() == "http"
                && host.and_then(|h| h.strip_suffix(".localhost")) == Some(APP_PAGES)
        }
        AppPageForm::CustomScheme => url.scheme() == APP_PAGES && host == Some("localhost"),
    }
}

/// A plugin whose navigation hook applies [`is_app_address`] to every window,
/// including the ones the front end opens later. A refused navigation is
/// dropped with one log line.
pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let dev_url = if tauri::is_dev() {
                webview.config().build.dev_url.as_ref()
            } else {
                None
            };
            let allowed = is_app_address(url, AppPageForm::CURRENT, dev_url);
            if !allowed {
                log::warn!(
                    "Window '{}' stayed on the app's own pages: a navigation elsewhere was refused",
                    webview.label()
                );
            }
            allowed
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEV_SERVER: &str = "http://localhost:1420";

    #[test]
    fn allows_only_the_app_own_pages() {
        let dev = Url::parse(DEV_SERVER).unwrap();
        let release: Option<&Url> = None;
        // (address, dev server, allowed on Windows, allowed elsewhere)
        let cases: &[(&str, Option<&Url>, bool, bool)] = &[
            // The bundled app pages: one form per platform.
            ("tauri://localhost", release, false, true),
            (
                "tauri://localhost/index.html?view=issue-map",
                release,
                false,
                true,
            ),
            ("http://tauri.localhost/", release, true, false),
            (
                "http://tauri.localhost/index.html?view=work-journal",
                release,
                true,
                false,
            ),
            ("https://tauri.localhost/index.html", release, false, false),
            // Empty and inline frames.
            ("about:blank", release, true, true),
            ("about:srcdoc", release, true, true),
            // The dev server, in a development build only.
            ("http://localhost:1420/", Some(&dev), true, true),
            (
                "http://localhost:1420/index.html?view=issue-map",
                Some(&dev),
                true,
                true,
            ),
            ("http://localhost:1420/", release, false, false),
            ("http://localhost:1421/", Some(&dev), false, false),
            ("https://localhost:1420/", Some(&dev), false, false),
            (
                "blob:http://localhost:1420/sample-id",
                Some(&dev),
                false,
                false,
            ),
            // Local-file addresses: this build does not serve them.
            ("asset://localhost/sample.png", release, false, false),
            ("http://asset.localhost/sample.png", release, false, false),
            ("https://asset.localhost/sample.png", release, false, false),
            // Anything else.
            ("https://example.com/", release, false, false),
            ("http://example.com/", Some(&dev), false, false),
            ("http://tauri.localhost.example.com/", release, false, false),
            ("http://tauri.localhost:8080/", release, false, false),
            ("tauri://localhost:8080/", release, false, false),
            ("tauri://example.com/", release, false, false),
            ("http://localhost/", release, false, false),
            ("file:///C:/sample/page.html", release, false, false),
            ("file:///tmp/sample/page.html", Some(&dev), false, false),
            ("data:text/html,<p>sample</p>", release, false, false),
            ("about:settings", release, false, false),
            // An app address that carries a user name or password.
            ("http://user@tauri.localhost/", release, false, false),
            ("http://user:secret@tauri.localhost/", release, false, false),
            ("tauri://user@localhost/", release, false, false),
            ("tauri://:secret@localhost/", release, false, false),
            ("http://user@localhost:1420/", Some(&dev), false, false),
        ];
        for (address, dev_url, on_windows, elsewhere) in cases {
            let url = Url::parse(address).unwrap();
            for (form, expected) in [
                (AppPageForm::LocalhostSubdomain, on_windows),
                (AppPageForm::CustomScheme, elsewhere),
            ] {
                assert_eq!(
                    is_app_address(&url, form, *dev_url),
                    *expected,
                    "{address} with {form:?} and dev server {dev_url:?}"
                );
            }
        }
    }
}
