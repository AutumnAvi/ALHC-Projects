import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Oct 25 notes: every choice list is the searchable SmartPicker (src/components/smart-picker.tsx),
  // never a native <select>, so pickers look and behave the same everywhere.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXOpeningElement[name.name='select']",
          message: "Use SmartPicker (@/components/smart-picker) instead of a native <select>.",
        },
      ],
      // Oct 26 notes, batch 4: no browser confirm() / alert() / prompt(); use the in-app modal
      // (useConfirm / useAlert from @/components/confirm).
      "no-alert": "error",
      "no-restricted-properties": [
        "error",
        { object: "window", property: "confirm", message: "Use useConfirm() from @/components/confirm." },
        { object: "window", property: "alert", message: "Use useAlert() from @/components/confirm." },
        { object: "window", property: "prompt", message: "Use an in-app dialog instead of window.prompt()." },
        { object: "globalThis", property: "confirm", message: "Use useConfirm() from @/components/confirm." },
        { object: "globalThis", property: "alert", message: "Use useAlert() from @/components/confirm." },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
