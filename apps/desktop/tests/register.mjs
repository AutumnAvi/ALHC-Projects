// The desktop launcher's unit tests run on Node's built-in test runner (`npm test`). Node can't run
// TypeScript as is, so this registers loader hooks (hooks.mjs, the same as packages/core's) that transpile
// .ts with the repo's own TypeScript. @alhc/core resolves through npm's workspace link. No extra
// dependencies.
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
