// `tauri icon` also writes Android and iOS icons. This app is desktop only (no phone app), so `npm run
// icons` removes them again.
import { rmSync } from "node:fs";

for (const dir of ["src-tauri/icons/android", "src-tauri/icons/ios"]) {
  rmSync(new URL(`../${dir}`, import.meta.url), { recursive: true, force: true });
}
