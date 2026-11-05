// Unit tests run on Node's built-in test runner (`npm test`). Node 20 can't run TypeScript, so this
// registers loader hooks (hooks.mjs) that transpile .ts / .tsx with the repo's own TypeScript, resolve the
// "@/…" alias to src/, and stub "server-only". The core package (@alhc/core/…) resolves through npm's
// workspace link and its package.json exports. No extra dependencies.
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
