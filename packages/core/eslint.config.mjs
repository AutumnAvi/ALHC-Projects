import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

// The core package is framework-free (docs/design/monorepo.md): the same TypeScript rules the web app runs,
// plus a wall around src/ — no Next.js, React, Node built-ins, server-only, Supabase's cookie clients, or
// the web app; no browser or Node globals. tsconfig.json checks the DOM side by type (no DOM library) and
// tests/boundaries.test.ts checks the imports again on every test run.
const NODE_BUILTINS = [
  "assert", "async_hooks", "buffer", "child_process", "cluster", "crypto", "dgram", "dns", "events", "fs",
  "http", "http2", "https", "module", "net", "os", "path", "perf_hooks", "process", "querystring", "readline",
  "stream", "string_decoder", "timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
];

// Browser-only, including what the WebWorker library declares that a page or Node lacks.
const BROWSER_GLOBALS = [
  "window", "document", "localStorage", "sessionStorage", "navigator", "location", "history", "self",
  "importScripts", "postMessage", "close", "caches", "indexedDB", "onmessage", "onmessageerror", "onerror",
  "onlanguagechange", "onoffline", "ononline", "onrejectionhandled", "onunhandledrejection",
];
const NODE_GLOBALS = ["process", "Buffer", "require", "module", "__dirname", "__filename", "global"];

export default defineConfig([
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "server-only", message: "Core runs anywhere; server-only belongs to the web app." },
            ...NODE_BUILTINS.map((name) => ({ name, message: "Core runs in browsers and desktop webviews too: no Node built-ins." })),
          ],
          patterns: [
            { group: ["next", "next/*"], message: "Core is framework-free: no Next.js (put adapters in apps/web/src/lib/server)." },
            { group: ["react", "react/*", "react-dom", "react-dom/*", "@tanstack/react-query"], message: "Core is framework-free: no React." },
            { group: ["node:*"], message: "Core runs in browsers and desktop webviews too: no Node built-ins." },
            { group: ["@supabase/ssr", "@supabase/ssr/*"], message: "Core never makes a client: the caller passes its own Db." },
            { group: ["@/*", "@alhc/web", "@alhc/web/*"], message: "Core can't import the web app." },
            { group: ["@alhc/core", "@alhc/core/*"], message: "Inside core, import with a relative path." },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...BROWSER_GLOBALS.map((name) => ({
          name,
          message: "Core has no DOM: take the value as an argument (or keep this in the web app).",
        })),
        ...NODE_GLOBALS.map((name) => ({
          name,
          message: "Core has no Node globals (process.env included): take the value as an argument.",
        })),
      ],
      // …nor through globalThis.
      "no-restricted-properties": [
        "error",
        ...[...BROWSER_GLOBALS, ...NODE_GLOBALS].map((property) => ({
          object: "globalThis",
          property,
          message: "Core has neither browser nor Node globals: take the value as an argument.",
        })),
      ],
    },
  },
]);
