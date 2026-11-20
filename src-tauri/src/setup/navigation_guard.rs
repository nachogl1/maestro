//! Keeps every app window on the app's own pages.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};
use url::Url;

/// The framework's schemes for app content. macOS and Linux load them as
/// `<scheme>://localhost`; Windows loads them as `http(s)://<scheme>.localhost`.
const APP_SCHEMES: [&str; 2] = ["tauri", "asset"];

/// The `about:` pages frames start on: an empty frame and an inline one.
const FRAME_PAGES: [&str; 2] = ["blank", "srcdoc"];

/// Whether a window may show `url`: true only for the app's own pages.
/// `dev_url` is the dev server address, passed in development builds only.
pub(crate) fn is_app_address(url: &Url, dev_url: Option<&Url>) -> bool {
    if url.scheme() == "about" {
        return FRAME_PAGES.contains(&url.path());
    }
    if dev_url.is_some_and(|dev| dev.origin() == url.origin()) {
        return true;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    if url.port().is_some() {
        return false;
    }
    match url.scheme() {
        "http" | "https" => APP_SCHEMES
            .iter()
            .any(|scheme| host.strip_suffix(".localhost") == Some(*scheme)),
        scheme => APP_SCHEMES.contains(&scheme) && host == "localhost",
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
            let allowed = is_app_address(url, dev_url);
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
        let cases: &[(&str, Option<&Url>, bool)] = &[
            // The bundled app pages on macOS and Linux, and on Windows.
            ("tauri://localhost", release, true),
            ("tauri://localhost/index.html?view=issue-map", release, true),
            ("http://tauri.localhost/", release, true),
            (
                "http://tauri.localhost/index.html?view=work-journal",
                release,
                true,
            ),
            ("https://tauri.localhost/index.html", release, true),
            // Local files the framework serves to the app.
            ("asset://localhost/sample.png", release, true),
            ("http://asset.localhost/sample.png", release, true),
            ("https://asset.localhost/sample.png", release, true),
            // Empty and inline frames.
            ("about:blank", release, true),
            ("about:srcdoc", release, true),
            // The dev server, in a development build only.
            ("http://localhost:1420/", Some(&dev), true),
            (
                "http://localhost:1420/index.html?view=issue-map",
                Some(&dev),
                true,
            ),
            ("http://localhost:1420/", release, false),
            ("http://localhost:1421/", Some(&dev), false),
            ("https://localhost:1420/", Some(&dev), false),
            // Anything else.
            ("https://example.com/", release, false),
            ("http://example.com/", Some(&dev), false),
            ("http://tauri.localhost.example.com/", release, false),
            ("http://tauri.localhost:8080/", release, false),
            ("tauri://example.com/", release, false),
            ("asset://example.com/sample.png", release, false),
            ("http://localhost/", release, false),
            ("file:///C:/sample/page.html", release, false),
            ("file:///tmp/sample/page.html", Some(&dev), false),
            ("data:text/html,<p>sample</p>", release, false),
            ("about:settings", release, false),
        ];
        for (address, dev_url, expected) in cases {
            let url = Url::parse(address).unwrap();
            assert_eq!(
                is_app_address(&url, *dev_url),
                *expected,
                "{address} with dev server {dev_url:?}"
            );
        }
    }
}
