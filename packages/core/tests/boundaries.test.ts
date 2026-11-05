// Big move 2 (docs/design/monorepo.md): the core package runs anywhere — the Next.js server, a browser, a
// desktop webview (Tauri), a test runner. So nothing in src/ may depend on Next.js, React, the DOM, Node,
// server-only, or process.env, and it reaches nothing outside the package but its own dependencies. The
// same wall stands in eslint.config.mjs (imports, globals) and tsconfig.json (no DOM or Node types); this
// checks it on every test run, with the type checker deciding what a name refers to.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PKG = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SRC = path.join(PKG, "src");
const rel = (f: string) => path.relative(PKG, f).split(path.sep).join("/");
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}
const FILES = walk(SRC);
const manifest = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const DEPENDENCIES = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);

function specifiersOf(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) out.push(n.arguments[0].text);
    else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "require") out.push("require()");
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) out.push(n.argument.literal.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test("src/ holds TypeScript modules only: no React components, no directives", () => {
  for (const file of FILES) {
    assert.ok(file.endsWith(".ts") && !file.endsWith(".d.ts"), `${rel(file)}: only .ts modules belong in core`);
    const text = fs.readFileSync(file, "utf8").trimStart();
    assert.ok(!/^["']use (client|server)["']/.test(text), `${rel(file)} has a Next.js directive`);
  }
});

test("core imports only itself (relative paths that stay in src/) and its declared dependencies", () => {
  for (const file of FILES) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const spec of specifiersOf(sf)) {
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const target = path.resolve(path.dirname(file), spec);
        assert.ok(target.startsWith(SRC + path.sep), `${rel(file)} imports ${spec}, outside the package`);
        continue;
      }
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      assert.ok(DEPENDENCIES.has(name), `${rel(file)} imports ${spec}: not a dependency of @alhc/core (Next.js, React, Node built-ins, server-only, and the web app never are)`);
    }
  }
});

test("core's dependencies are framework-free", () => {
  for (const name of DEPENDENCIES) {
    assert.ok(
      !/^(next|react|react-dom|server-only|@supabase\/ssr|@tanstack\/react-query|@vercel\/|@alhc\/web)/.test(name),
      `@alhc/core depends on ${name}`,
    );
  }
});

// What a name refers to is the type checker's call (a local `const window = …` is fine; the global isn't).
// With core's tsconfig (no DOM, no Node types) the Node globals don't exist at all and the browser-only
// ones that the web platform also defines in workers (self, location, navigator) are caught here.
const BANNED_GLOBALS = new Set([
  "window", "document", "localStorage", "sessionStorage", "navigator", "location", "history", "self",
  "process", "Buffer", "require", "module", "__dirname", "__filename", "global",
]);

test("no browser or Node globals (process.env included): values come in as arguments", () => {
  const configFile = ts.findConfigFile(PKG, ts.sys.fileExists, "tsconfig.json");
  assert.ok(configFile, "packages/core/tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  assert.ok(parsed);
  assert.deepEqual(parsed.options.types, [], "core is checked without Node types");
  assert.ok(!(parsed.options.lib ?? []).some((lib) => /dom/i.test(lib)), "core is checked without the DOM library");
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const found: string[] = [];
  for (const sf of program.getSourceFiles()) {
    if (!path.resolve(sf.fileName).startsWith(SRC + path.sep)) continue;
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && BANNED_GLOBALS.has(n.text)) {
        const parent = n.parent;
        const isName =
          (ts.isPropertyAccessExpression(parent) && parent.name === n) ||
          (ts.isQualifiedName(parent) && parent.right === n) ||
          ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) ||
            ts.isMethodDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent) ||
            ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent)) && parent.name === n);
        if (!isName) {
          const symbol = checker.getSymbolAtLocation(n);
          // A global: declared by a default library or by @types/* (Node's types, pulled in by a stray
          // node: import), never by core itself.
          const ambient = (sf: ts.SourceFile) => program.isSourceFileDefaultLibrary(sf) || /[\\/]node_modules[\\/]@types[\\/]/.test(sf.fileName);
          const global = !symbol || (symbol.declarations ?? []).every((d) => ambient(d.getSourceFile()));
          if (global) found.push(`${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} uses ${n.text}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  assert.deepEqual(found, []);
});

test("only the layer (src/api/) talks to Supabase; the rest of core is pure", () => {
  const call = /\.rpc\(|\.from\(\s*"[a-z_]+"\s*\)|\.storage\b|\bauth\.(get|sign|exchange|update|reset|set|admin|verify|refresh)/;
  for (const file of FILES) {
    if (rel(file).startsWith("src/api/")) continue;
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => assert.ok(!call.test(line), `${rel(file)}:${i + 1} calls Supabase outside the layer: ${line.trim()}`));
  }
});
