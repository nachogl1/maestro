/**
 * Front-end errors into the app's log file.
 *
 * A release build has no web console, so a handler that throws or a promise
 * that rejects leaves no trace: a button just "does nothing". This copies
 * every `console.error`, uncaught error and unhandled rejection into the log
 * file (via `log_frontend_message`), and still prints it as before.
 */

import { invoke } from "@tauri-apps/api/core";

function errorText(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Starts forwarding; returns a function that stops it. */
export function forwardErrorsToLog(): () => void {
  // A failed send stays silent, so it can never report itself in a loop.
  const send = (message: string) => {
    invoke("log_frontend_message", { level: "error", message }).catch(() => {});
  };

  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    originalError(...args);
    send(args.map(errorText).join(" "));
  };
  const onError = (event: ErrorEvent) => {
    send(`Uncaught: ${errorText(event.error ?? event.message)}`);
  };
  const onRejection = (event: Event) => {
    send(`Unhandled rejection: ${errorText((event as PromiseRejectionEvent).reason)}`);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    console.error = originalError;
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
