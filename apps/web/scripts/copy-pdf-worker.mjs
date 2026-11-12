// Nov 12 notes (batch 40, item 7): pdf.js's browser worker as a static file (public/pdfjs/), which the
// review viewer points at. Resolving it through the bundler (new URL(…, import.meta.url)) made every build
// warn that pdfjs-dist is a server package (serverExternalPackages, for the thumbnail route's Node copy).
// Runs before `next dev` / `next build`; the file name carries pdf.js's version, so a new release is a
// new URL. The copy isn't committed (.gitignore).
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve("pdfjs-dist/package.json"));
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "pdfjs");
mkdirSync(out, { recursive: true });
copyFileSync(path.join(root, "build", "pdf.worker.min.mjs"), path.join(out, `pdf.worker.${version}.min.mjs`));
