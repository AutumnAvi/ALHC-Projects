import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SRC = path.join(ROOT, "src");
const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"];

function withExtension(file) {
  if (existsSync(file) && statSync(file).isFile()) return file;
  for (const ext of EXTENSIONS) if (existsSync(file + ext)) return file + ext;
  for (const ext of EXTENSIONS) {
    const index = path.join(file, `index${ext}`);
    if (existsSync(index)) return index;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  let file = null;
  if (specifier.startsWith("@/")) file = withExtension(path.join(SRC, specifier.slice(2)));
  else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const parent = fileURLToPath(context.parentURL);
    if (/\.(ts|tsx)$/.test(parent)) file = withExtension(path.resolve(path.dirname(parent), specifier));
  }
  if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
  try {
    return await next(specifier, context);
  } catch (error) {
    // Packages like next ship CommonJS subpaths without an exports map ("next/headers" → headers.js).
    if (error?.code === "ERR_MODULE_NOT_FOUND" && /^[^./][^:]*\/[^/]+$/.test(specifier) && !specifier.endsWith(".js")) {
      return next(`${specifier}.js`, context);
    }
    throw error;
  }
}

export async function load(url, context, next) {
  if (url.startsWith("file:") && /\.(ts|tsx)$/.test(url)) {
    const file = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        verbatimModuleSyntax: false,
      },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  }
  return next(url, context);
}
