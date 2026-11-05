import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// The desktop launcher (big move 3, docs/design/desktop.md): the same TypeScript rules as packages/core,
// and the same ban on browser dialogs as the web app (the launcher shows its own messages).
export default defineConfig([
  // src-tauri holds Rust; only its page script (src-tauri/src/page.js) is linted here.
  globalIgnores(["dist/**", "src-tauri/target/**", "src-tauri/gen/**"]),
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      "no-alert": "error",
    },
  },
]);
