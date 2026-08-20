import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/**
 * Native OS notification (issue #174 follow-up): unlike the in-app toast
 * stack, this reaches the user when Maestro is minimized or behind other
 * windows — which is exactly the situation a supervised, autonomous run
 * dies in.
 *
 * Best effort by design: permission is checked (and requested once) on
 * first use, and every failure is logged and swallowed — the in-app toast
 * and the persistent attention badge are the guaranteed surfaces, the OS
 * pop-up is reach, not truth.
 */
export async function notifyOs(title: string, body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
    if (granted) {
      sendNotification({ title, body });
    }
  } catch (err) {
    console.error("OS notification failed:", err);
  }
}
