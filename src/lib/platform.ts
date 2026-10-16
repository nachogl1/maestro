/**
 * Detect whether the app is running on macOS (for platform-specific UI such as native traffic lights).
 */
export function isMac(): boolean {
  return navigator.platform.toLowerCase().includes("mac");
}

/**
 * Detect whether the app is running on Windows (WebView2 reports `Win32`), for features the
 * backend does not support there, such as installing the `maestro` CLI command.
 */
export function isWindows(): boolean {
  return navigator.platform.toLowerCase().startsWith("win");
}
