import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";

// Core imports each other with extensionless relative paths (as bundlers do); tests import the package by
// its own name ("@alhc/core/views"), which Node resolves through package.json's exports.
const EXTENSIONS = [".ts", ".mjs", ".js"];

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
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const parent = fileURLToPath(context.parentURL);
    if (/\.ts$/.test(parent)) {
      const file = withExtension(path.resolve(path.dirname(parent), specifier));
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith("file:") && /\.ts$/.test(url)) {
    const file = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        verbatimModuleSyntax: false,
      },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  }
  return next(url, context);
}
