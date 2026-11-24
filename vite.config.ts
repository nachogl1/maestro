/// <reference types="vitest/config" />

import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

/** Package name for a node_modules id, e.g. "@tiptap/react" or "remark-gfm". */
function packageOf(id: string): string | undefined {
  const norm = id.replace(/\\/g, "/");
  const marker = "node_modules/";
  const idx = norm.lastIndexOf(marker);
  if (idx === -1) return undefined;
  const parts = norm.slice(idx + marker.length).split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

// react-markdown pulls in the whole unified/remark/rehype/micromark ecosystem.
// It is only reached through MarkdownBody, which loads it on demand.
const MARKDOWN_PKG =
  /^(react-markdown|unified|bail|trough|devlop|zwitch|ccount|longest-streak|markdown-table|trim-lines|hastscript|web-namespaces|html-void-elements|html-url-attributes|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities(-.+)?|parse-entities|stringify-entities|(remark|rehype|micromark|mdast|hast|unist|vfile)(-.+)?)$/;

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // .claude holds agent worktrees (full repo copies); target is Rust output.
      ignored: ["**/src-tauri/**", "**/.claude/**", "**/target/**"],
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Keep the click-only heavy libraries out of the entry chunk so
        // WebView2 does not parse them before the terminals can paint.
        // @xterm deliberately stays in the entry chunk — terminals are the
        // first thing the user needs.
        manualChunks(id: string) {
          if (/\.(css|scss|sass|less|styl)(\?.*)?$/.test(id)) return;
          const pkg = packageOf(id);
          if (!pkg) return;
          if (
            pkg.startsWith("@tiptap/") ||
            pkg.startsWith("prosemirror-") ||
            pkg === "tiptap-markdown"
          ) {
            return "vendor-editor";
          }
          if (MARKDOWN_PKG.test(pkg)) return "vendor-markdown";
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    // Without an explicit include, vitest also collects the full test suite
    // out of every stale agent worktree under .claude/worktrees.
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      ".github/scripts/**/*.test.mjs",
      "scripts/**/*.test.mjs",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/target/**"],
  },
}));
