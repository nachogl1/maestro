/**
 * Input and clipboard wiring for one xterm.js terminal bound to a PTY session:
 * OSC 52 copy, IME composition fix, image paste, keystrokes → stdin, resize →
 * PTY, and the app's keyboard shortcuts. Extracted verbatim from TerminalView's
 * mount effect.
 */
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import type { Terminal } from "@xterm/xterm";

import { resizePty, savePastedImage, writeStdin } from "@/lib/terminal";
import { useSessionStore } from "@/stores/useSessionStore";

/**
 * Writes text to the system clipboard reliably.
 *
 * Prefers the Tauri clipboard plugin (writes from the Rust side, so it works
 * even when invoked outside a direct user gesture — e.g. from an OSC 52 escape
 * sequence that arrives asynchronously via the PTY). Falls back to the browser
 * Clipboard API if the plugin call fails.
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await writeClipboardText(text);
  } catch (err) {
    console.warn("Tauri clipboard write failed, falling back to navigator.clipboard:", err);
    await navigator.clipboard.writeText(text);
  }
}

/**
 * Decodes a base64 string (as carried by an OSC 52 clipboard sequence) into a
 * UTF-8 string. `atob` only yields a binary string, so we re-decode the bytes
 * to preserve multi-byte characters.
 */
function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Handle OSC 52 clipboard escape sequences. TUI apps like Claude Code copy
 * selected text by emitting OSC 52 ("\x1b]52;c;<base64>\x07") rather than
 * relying on xterm's own selection. xterm.js does NOT write to the system
 * clipboard on its own, so without this handler the app prints "Copied to
 * clipboard" but nothing actually lands on the clipboard. The payload is
 * "<targets>;<base64data>"; a "?" payload is a paste/read request, which
 * we don't support (returning false leaves it unhandled).
 */
export function registerOsc52Clipboard(term: Terminal): void {
  term.parser.registerOscHandler(52, (payload) => {
    const sep = payload.indexOf(";");
    if (sep === -1) return false;
    const b64 = payload.slice(sep + 1);
    if (b64 === "?" || b64.length === 0) return false;
    try {
      copyToClipboard(decodeBase64Utf8(b64)).catch((err) =>
        console.error("OSC 52 clipboard write failed:", err),
      );
    } catch (err) {
      console.error("OSC 52 decode failed:", err);
      return false;
    }
    return true; // handled — suppress xterm's default (no-op) handling
  });
}

/**
 * Wires keystrokes, pastes and resizes of `term` to the PTY session.
 * @param onReplyToPrompt - Called when Enter answers a NeedsInput prompt (status already set to Working).
 * @returns Disposer that removes the paste listener and the xterm data/resize listeners.
 */
export function attachXtermInput(
  term: Terminal,
  container: HTMLElement,
  sessionId: number,
  onReplyToPrompt: () => void,
): () => void {
  // Workaround for xterm.js CompositionHelper bug on WebKit (Tauri/WKWebView):
  // The hidden textarea accumulates text across compositions, but CompositionHelper
  // uses textarea.value.length at compositionstart as the extraction offset. When
  // prior text remains in the textarea, it extracts the wrong substring — e.g.
  // sending "測試" instead of "這是". We capture the correct text from the
  // compositionend event and replace whatever xterm sends via onData.
  // term.open() always creates the hidden textarea synchronously.
  const textarea = term.textarea;
  if (!textarea) throw new Error("expected xterm to have created its textarea on open()");
  let pendingCompositionData: string | null = null;

  textarea.addEventListener("compositionend", (e) => {
    pendingCompositionData = (e as CompositionEvent).data;
  });

  // Intercept paste events to handle images from the clipboard.
  // xterm.js only pastes text; images are silently dropped. We detect image
  // data, save it to a temp file via the backend, and write the file path
  // into the terminal so the AI CLI can read it.
  const pasteHandler = (e: Event): void => {
    const clipboardEvent = e as ClipboardEvent;
    const items = clipboardEvent.clipboardData?.items;
    if (!items) return;

    let imageItem: DataTransferItem | null = null;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        imageItem = item;
        break;
      }
    }

    if (!imageItem) return; // No image — let xterm handle text paste

    // Block xterm.js from processing this paste event
    e.preventDefault();
    e.stopPropagation();

    const blob = imageItem.getAsFile();
    if (!blob) return;

    const mediaType = imageItem.type;
    const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // 50 MB
    // Save image async, then write the path to stdin
    blob
      .arrayBuffer()
      .then(async (arrayBuffer) => {
        if (arrayBuffer.byteLength > MAX_IMAGE_SIZE) {
          console.error("[TerminalView] Image too large to paste");
          return;
        }
        // Hand the view straight to the IPC layer — building a JS array with
        // one element per image byte first is what made large pastes freeze.
        const filePath = await savePastedImage(new Uint8Array(arrayBuffer), mediaType);
        await writeStdin(sessionId, filePath);
      })
      .catch((err) => {
        console.error("[TerminalView] Failed to paste image:", err);
      });
  };
  container.addEventListener("paste", pasteHandler, { capture: true });

  // NOTE: Drag-and-drop is intentionally NOT handled here per-terminal.
  // Tauri's onDragDropEvent is webview-global — registering a listener in
  // every TerminalView meant a single drop fired *every* listener, so the
  // dropped path ended up written to every session's PTY. Drag-drop is
  // owned by TerminalGrid + useTerminalDragDrop, which does proper
  // coordinate hit-testing against the [data-slot-id] DOM elements and
  // routes the path to exactly one session.

  const dataDisposable = term.onData((data) => {
    if (pendingCompositionData !== null) {
      const correctData = pendingCompositionData;
      pendingCompositionData = null;
      // Clear textarea to prevent accumulation that corrupts future compositions
      textarea.value = "";
      if (correctData.length > 0) {
        writeStdin(sessionId, correctData).catch(console.error);
      }
      return;
    }
    // Enter while the agent awaits a reply: the user is responding, so
    // flip the indicator back to Working before output resumes. Only the
    // bare Enter key emits exactly "\r" — pastes and escape sequences
    // never match, so they can't clear the needs-input flag.
    if (data === "\r") {
      const current = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
      if (current?.status === "NeedsInput") {
        onReplyToPrompt();
        useSessionStore.getState().updateSession(sessionId, {
          status: "Working",
          statusMessage: undefined,
          needsInputPrompt: undefined,
        });
        // Answering the prompt also clears the auto-unpark attention
        // highlight — the pane can gain focus without a click (keyboard
        // nav, file drop), so replying may be the acknowledging gesture.
        useSessionStore.getState().clearSessionAttention(sessionId);
      }
    }
    writeStdin(sessionId, data).catch(console.error);
  });

  const resizeDisposable = term.onResize(({ rows, cols }) => {
    resizePty(sessionId, rows, cols).catch(console.error);
  });

  // Handle special keyboard shortcuts
  term.attachCustomKeyEventHandler((event) => {
    // Shift+Enter: send Kitty keyboard protocol sequence for Shift+Enter
    // so Claude Code inserts a newline in its input buffer instead of executing.
    // Raw "\n" would be treated as a command terminator by the CLI.
    // Block all event types (keydown, keypress, keyup) to prevent xterm.js
    // from also sending "\r" on the keypress event.
    if (event.key === "Enter" && event.shiftKey) {
      if (event.type === "keydown") {
        writeStdin(sessionId, "\x1b[13;2u").catch(console.error);
      }
      return false;
    }

    // Cmd+C (Mac) or Ctrl+C (Linux/Windows): copy selection to clipboard
    // Only intercept if there's a selection, otherwise let SIGINT go through
    const isCopy =
      event.key === "c" && (event.metaKey || event.ctrlKey) && event.type === "keydown";
    if (isCopy && term.hasSelection()) {
      const selection = term.getSelection();
      copyToClipboard(selection).catch(console.error);
      return false; // Don't send to PTY
    }

    // Cmd/Ctrl+T: add new session — block xterm so 't' isn't sent to PTY.
    // The DOM event still bubbles to window where useAppKeyboard handles it.
    if (
      event.key === "t" &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.type === "keydown"
    ) {
      return false;
    }

    // Cmd/Ctrl+1 (toggle maximize) and Cmd/Ctrl+2 (toggle git panel):
    // block xterm so it doesn't send the corresponding control byte (NUL/SOH) to PTY.
    // Use event.code for layout independence; event.key may differ on AZERTY etc.
    if (
      (event.code === "Digit1" ||
        event.code === "Digit2" ||
        event.code === "Numpad1" ||
        event.code === "Numpad2") &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.type === "keydown"
    ) {
      return false;
    }

    // Cmd+K (Mac) or Ctrl+K (Linux/Windows): clear terminal scrollback + viewport
    if (
      event.key === "k" &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.type === "keydown"
    ) {
      term.clear();
      return false;
    }

    // Cmd+Left/Right (Mac): jump to beginning/end of line
    // Cmd+Delete (Mac): delete from cursor to beginning of line
    // WebView intercepts Cmd+key by default, so we manually send the escape sequences
    if (event.metaKey && event.type === "keydown") {
      if (event.key === "ArrowLeft") {
        writeStdin(sessionId, "\x01").catch(console.error); // Ctrl+A: beginning of line
        return false;
      }
      if (event.key === "ArrowRight") {
        writeStdin(sessionId, "\x05").catch(console.error); // Ctrl+E: end of line
        return false;
      }
      if (event.key === "Backspace") {
        writeStdin(sessionId, "\x15").catch(console.error); // Ctrl+U: delete to beginning of line
        return false;
      }
    }

    return true; // Let xterm handle all other keys
  });

  return () => {
    container.removeEventListener("paste", pasteHandler, { capture: true });
    dataDisposable.dispose();
    resizeDisposable.dispose();
  };
}
