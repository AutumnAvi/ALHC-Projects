// The core package's unit tests run on Node's built-in test runner (`npm test`). Node can't run
// TypeScript as is, so this registers loader hooks (hooks.mjs) that transpile .ts with the repo's own
// TypeScript. No extra dependencies.
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
