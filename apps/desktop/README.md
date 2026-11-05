# ALHC Projects for Mac and Windows (`@alhc/desktop`)

A Tauri v2 shell around the hosted web app (https://alhc-projects.vercel.app). Online-only. Why it's built
this way, and how links, downloads, sign-in, and security work: [docs/design/desktop.md](../../docs/design/desktop.md).
Signing and shipping: [docs/desktop-release.md](../../docs/desktop-release.md).

## Run it

Prerequisites: Node 22 and the workspace installed (`npm ci` at the repo root), Rust stable
(https://rustup.rs; `src-tauri/rust-toolchain.toml` pins the release CI checks with, and rustup installs it), and the platform's webview tools:

- **macOS**: Xcode or the Command Line Tools (`xcode-select --install`).
- **Windows**: Microsoft C++ Build Tools ("Desktop development with C++") and WebView2 (part of Windows
  11; https://developer.microsoft.com/microsoft-edge/webview2/ for Windows 10).
- **Linux** (development only): `libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev
  librsvg2-dev` (https://v2.tauri.app/start/prerequisites/#linux).

From the repo root:

```bash
npm run desktop:dev                                         # the app against the hosted site
ALHC_APP_URL=http://localhost:3000 npm run desktop:dev      # against `npm run dev` (the web app on this computer)
npm run desktop:build                                       # an installer for this computer (unsigned): src-tauri/target/release/bundle/
```

`desktop:dev` is `tauri dev`: it serves the launcher page from Vite (port 1420), builds the Rust shell, and
opens the window. The app's address is compiled in, so changing `ALHC_APP_URL` rebuilds the shell. A
development build registers the `alhc://` scheme for you while it runs (Windows, Linux); on macOS only an
installed `.app` gets it (build one and open it from Applications).

Try a deep link while it runs:

```bash
open 'alhc://inbox?tab=mentioned'                           # macOS (installed app)
start alhc://inbox                                          # Windows
xdg-open 'alhc://task/<task id>'                            # Linux
```

`ALHC_DESKTOP_DEBUG=1` prints every navigation decision (scheme, host, and the path's first segment: paths and queries can carry tokens). `ALHC_SUPABASE_URL` points the signed-file allowance at another Supabase project (a local `supabase start`, say).

## Checks

```bash
npm run lint --workspace @alhc/desktop          # also part of the root `npm run lint`
npm run typecheck --workspace @alhc/desktop     # the launcher (DOM) and its tests (Node)
npm test --workspace @alhc/desktop              # the launcher's rules (tests/launcher.test.ts)
npm run build:frontend --workspace @alhc/desktop
cd apps/desktop/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

The deep-link mapping is `@alhc/core/desktop-links`, tested with the core (`npm test --workspace @alhc/core`).

## Layout

```
index.html, src/          The launcher page: the only page the app ships. Checks the app answers, then opens it
  launcher.ts             Its rules (where the window goes, retries), unit-tested
  main.ts                 Its DOM ("Opening…", "Can't reach ALHC Projects", Try again)
tests/                    The launcher's unit tests (Node's runner; hooks.mjs transpiles TypeScript like core's)
scripts/                  drop-mobile-icons.mjs (after `npm run icons`)
src-tauri/
  tauri.conf.json         Product name, bundle id, version (../package.json), the launcher's CSP, no capabilities, bundles, the alhc scheme
  Cargo.toml, Cargo.lock  The shell's dependencies: Tauri, deep-link, single-instance, opener, window-state
  src/lib.rs              Plugins, the main window, window events
  src/shell.rs            Windows, popups, downloads, Reload, deep links, the stale-page reload
  src/policy.rs           Where a webview may go (unit-tested)
  src/menu.rs             The macOS (and Linux) menus
  src/page.js             The script every page gets (window.__ALHC_DESKTOP__, file links, sign-up / reset links, macOS print)
  icons/icon.svg          The icon's source (the sign-in screen's "A" tile); `npm run icons` makes every size
```
