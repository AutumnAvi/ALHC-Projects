# Desktop app (big move 3)

Status: built (Nov 5, 2026). ALHC Projects for Mac and Windows, online-only: no offline mode, no local
database, no sync. It talks to the same hosted backend as the web app (https://alhc-projects.vercel.app
and its Supabase project). The phone app comes later and isn't part of this.

Code: `apps/desktop` (`@alhc/desktop`, Tauri v2) and `packages/core/src/desktop-links.ts`. How to run it:
[apps/desktop/README.md](../../apps/desktop/README.md). How to sign and ship it:
[docs/desktop-release.md](../desktop-release.md).

## The decision: wrap the hosted web app

There were two ways to build it:

- **(a) A shell around the hosted app.** A Tauri window loads https://alhc-projects.vercel.app; the shell
  adds what a desktop app needs (its own window and icon, `alhc://` links, downloads, menus) and nothing
  else.
- **(b) A local UI.** A UI bundled in `apps/desktop`, on `@alhc/core`, calling Supabase directly.

**We chose (a).** It is the more reliable option and much the cheaper one to keep up, because the web app
is built to run on the server:

| | (a) shell around the hosted app | (b) local UI on `@alhc/core` |
| --- | --- | --- |
| What has to be built | the shell (about 1,000 lines of Rust, a quarter of them tests, and a 4 KB launcher page) | ≈72 screens that are Server Components today (85 server-read pages and layouts), 331 Server Actions, the routing, Realtime, sign-in and session storage, and ≈74,000 lines of client UI moved off `next/*` |
| Features that need the server | all work as they are | review emails and thumbnails, Slack, signing secrets, avatar upload, the Asana import, and CSV export still need server routes. The JSON routes take cookies only and send no CORS headers, so they'd need bearer-token auth and CORS first |
| A new feature or fix | there with the next Vercel deploy, no desktop release | built twice (web and desktop), and shipped in a desktop release |
| Sign-in | the web app's email-and-password sign-in, unchanged | new PKCE / session code in the app |
| Access rules | the same pages and the same RLS | the same RLS, but with a second client to keep right |
| Offline | not needed (online-only) | the one thing (b) would make possible, and it isn't wanted |

Facts behind this, from the audit (Nov 5):

- Every page is a Server Component; 85 of the 96 pages and layouts read data on the server. Writes are 331
  Server Actions in 38 `"use server"` files. A Server Action called from another origin (a local
  `tauri://` page) is refused by Next.js's origin check (no `serverActions.allowedOrigins`), and action ids
  change with every build.
- The session is in cookies (`@supabase/ssr`, `sb-<project>-auth-token`, `SameSite=Lax`). The server
  never reads an `Authorization` header, and no route sends CORS headers.
- Nothing stops the site loading as a webview's top-level page: no CSP, no `X-Frame-Options`, and no
  user-agent checks. In (a) the page is the site itself, so its cookies are first-party and the Server
  Actions origin check passes.
- `@alhc/core` has no UI (no React is allowed in it); a shared `packages/ui` doesn't exist yet
  (docs/design/monorepo.md).

What (a) costs is that some desktop niceties depend on the web app (notifications, a Dock badge: see
below), and a few webview gaps need covering in the shell. Both are small and listed here. If an offline
mode or a native UI is ever wanted, (b) is still open: `@alhc/core` and its transport were built for it.

## How it works

```
the app starts ──► main window: launcher page (bundled, apps/desktop/index.html)
                     │  checks the app answers (GET <app>/favicon.ico)
                     │  ├─ yes ──► location.replace(<app>/<page>)   ← the hosted web app, signed in or not
                     │  └─ no ───► "Can't reach ALHC Projects", retries (2, 4, 8, 15, 30 s; Try again; when online)
alhc://… link ─────► (a second launch hands it to the running app) ──► main window: launcher?open=<link> ──► <app>/<page>
target=_blank ─────► an app page or a stored file: another app window (same session); anything else: the browser
```

- **One page ships with the app**: the launcher (`index.html`, `src/main.ts`, rules in
  `src/launcher.ts`). It never shows app data; it only decides where the window goes and says when the app
  can't be reached. It uses no Tauri API.
- **The shell** (`src-tauri/src`): `lib.rs` (plugins, the main window, events), `shell.rs` (windows,
  downloads, Reload, deep links), `policy.rs` (where a webview may go; unit-tested), `menu.rs` (macOS menus),
  `page.js` (the script every page gets).
- **The app's address** is compiled in: `https://alhc-projects.vercel.app`, or `ALHC_APP_URL` at build time
  (`http://localhost:3000` to work on the web app, or a custom domain later). So is its Supabase project's
  (`https://xsgmawawwstbrbukgsax.supabase.co`, or `ALHC_SUPABASE_URL`: the web app's
  `NEXT_PUBLIC_SUPABASE_URL`), for the signed file URLs below. It must be the same host as
  the web app's `NEXT_PUBLIC_APP_URL`: cookies belong to one host, and email links use that one. The shell
  passes it to its pages as `window.__ALHC_DESKTOP__ = { appOrigin, platform, version }` (the launcher reads
  it; the web app could use it later to tell it runs in the desktop app).
- **Its version** is `apps/desktop/package.json`'s (`tauri.conf.json` → `"version": "../package.json"`).
  The bundle id is `com.autumnlakemarketing.alhcprojects`.

## Sign-in

- **Email and password work unchanged.** The login form is the web app's (`/login`, the `passwordAuth`
  Server Action, the allowlist gate). The session cookies live in the app's own webview store, which
  persists across restarts and is separate from the person's browser (signing in to one doesn't sign in
  the other). Signing out is the web app's `POST /auth/signout`.
- **Sign-up and password reset happen in the browser.** Their email links carry a PKCE code verifier
  stored as a cookie in whatever asked for the email, and mail apps open links in the system browser. A
  reset asked for in the desktop app would land in the browser without its verifier and fail ("expired").
  So the shell opens `/signup` and `/forgot-password` in the system browser (the navigation policy for real
  loads; `page.js` turns the login page's client-side links into real loads first). The person confirms or
  resets there, then signs in here with their password. A reset signs out every session (`signOut` with
  scope global), the desktop one included, so it asks to sign in again.
- **Session lifetime.** The proxy refreshes the session and rewrites the cookies with `Set-Cookie` (400
  days). WebKit may cap cookies written by script (`document.cookie`) at seven days; only the browser
  client's own refresh writes that way, and the next server refresh rewrites them. Worth checking once in
  the QA pass below (an idle week on macOS).
- **Google sign-in (later; not built).** Google refuses OAuth inside embedded webviews
  (`disallowed_useragent`), so it has to run in the system browser and come back through a deep link:
  1. In the desktop app the Google button starts the flow with `signInWithOAuth({ provider: "google",
     options: { redirectTo: "https://alhc-projects.vercel.app/auth/desktop", skipBrowserRedirect: true } })`.
     That writes the PKCE verifier into the desktop webview's cookies and returns Google's URL without
     leaving the page; the shell opens that URL in the browser (an allowed external link).
  2. Google → Supabase → `/auth/desktop?code=…` opens in the browser: a small public page that
     immediately hands the code on as `alhc://auth/callback?code=…` (and says "You can close this tab").
  3. The shell receives the deep link and loads `/auth/callback?code=…` in the desktop window, where the
     existing route exchanges the code with the verifier from step 1 and runs the allowlist gate.

  What that needs: the button change (`skipBrowserRedirect` when `window.__ALHC_DESKTOP__` is set), the
  `/auth/desktop` page, an `auth/callback` short form in `desktop-links.ts`, and a Redirect URL in Supabase
  Auth for `/auth/desktop` (Avi: phases never change Auth settings). It only makes sense once Google
  sign-in is turned on for the web app.

## Deep links

`alhc://` opens a page of the app in the desktop app (`packages/core/src/desktop-links.ts`, tested in
`packages/core/tests/desktop-links.test.ts`):

| Link | Opens |
| --- | --- |
| `alhc://projects/<id>[/views/<view>…]?task=<id>` | the same path and query on the app (any of its sections) |
| `alhc://inbox?tab=mentioned`, `alhc://my-tasks`, `alhc://search?q=…`, `alhc://portfolios/<id>`, `alhc://teams/<id>/calendar`, `alhc://people/<id>`, `alhc://approve/<task>`, `alhc://reports`, … | the same path and query |
| `alhc://task/<id>` | `/my-tasks?task=<id>` (the pane opens any task you can read) |
| `alhc://settings[/<tab>]` | `/?settings=<tab>` |
| `alhc://` or `alhc://home` | Home |

- Only the signed-in app's sections open (`DESKTOP_LINK_SECTIONS`); anything else (auth pages, the API,
  files, odd characters, a path that climbs out, or a section with no page of its own, such as a bare
  `alhc://projects`) opens Home. The app decides what the person may see
  exactly as for a typed address, and a signed-out person signs in first and lands on the page
  (`/login?next=`).
- `desktopLinkFor(path)` builds the link for a page (for a future "Open in desktop app").
- **Registration.** The scheme is in `tauri.conf.json` (`plugins.deep-link.desktop.schemes`): the macOS
  bundle's `Info.plist` and the Windows installers register it. A development build registers it only with
  `ALHC_DESKTOP_REGISTER_SCHEME=1` (Windows, Linux): the registration stays after it exits and points
  `alhc://` at the development build, an installed app's links included (the Windows installer registers
  per user, under the same key), until the app is reinstalled. macOS hands links to the running app;
  Windows and Linux start a new process with the link, which the single-instance plugin passes to the
  running app before it exits.
- The shell sends the link to the launcher (`index.html?open=<link>`), which maps it and checks the app
  answers first; the Rust side never maps links itself.

## Links, windows, downloads, print

The navigation policy (`policy.rs`, unit-tested) decides every load of every frame (WKWebView and WebKitGTK
ask for iframes too; WebView2 for the main frame):

| A load of… | in the main window | in another app window |
| --- | --- | --- |
| the launcher page | allowed | refused |
| the app (`<app origin>/…`) | allowed; `/signup` and `/forgot-password` open in the browser | the same |
| a signed file of the app's Supabase project (`<supabase>/storage/v1/object/sign/…`: what `/attachments/<id>` and the review routes redirect to) | allowed (PDF frames, previews) | allowed |
| `about:blank` / `about:srcdoc` (empty frames) | allowed | allowed |
| another website, `mailto:`, `webcal:`, `tel:` | opened by the system (browser, mail app, calendar) | the same |
| anything else (`file:`, `data:`, other schemes) | refused | refused |

- **New windows** (`target="_blank"`, ⌘-click): an app page or a stored file opens another app window that
  shares the session (a file preview, a public form, "Open review page"); anything else goes to the
  browser. (WebKitGTK, which only Linux development builds use, drops plain `target="_blank"` links.) The
  opener plugin's own link script is off (`open_js_links_on_click(false)`): it would cancel these clicks
  and ask for `open_url` over IPC, which pages don't get, so they would do nothing.
- **Opening other apps is limited**: the same URL twice within two seconds opens once, and at most five
  open in ten seconds (`ExternalGate`). A browser only opens other apps after a click; the shell can't tell
  a click from a frame loading a link, so it limits instead.
- **Downloads.** CSV exports are `<a download>` links. `page.js` turns a click on a file link
  (`/attachments/<id>`, `/review-files/<id>`, not a preview) into the same kind of download, so a file never
  replaces the app (WKWebView would show an image or a PDF in place) and no empty window is left behind.
  macOS: the file goes to Downloads (an existing name gets " (1)") and is shown in Finder when it's done.
  Windows: WebView2 saves it and shows its own downloads list. Linux: the XDG Downloads folder (the current
  folder when none is set).
- **Print.** WKWebView ignores `window.print()`, so on macOS `page.js` replaces it: it asks the shell by
  loading `alhc-shell://print`, which the policy cancels and turns into the window's native print; File →
  Print (⌘P) does the same. The app's "Print task" waits for `afterprint`, which goes out with the next
  click or key press (it only affects print styles). WebView2 and WebKitGTK print by themselves.
- **Drag and drop.** Tauri's file-drop capture is off (`disable_drag_drop_handler`): the app's own HTML drag
  and drop (List, Board, uploads) needs it off, notably on Windows.
- **Menus and keys.** macOS gets an app menu (About, Hide, Quit), File (Open in Browser ⇧⌘O, Print ⌘P,
  Close ⌘W), Edit (without it ⌘C / ⌘V / ⌘A don't work in a WKWebView), View (Reload ⌘R through the launcher,
  Actual Size ⌘0, Zoom In ⌘=, Zoom Out ⌘-, Back ⌘[, Forward ⌘], Full screen), and Window. Zoom is the
  shell's (`set_zoom`, Safari's steps, per window): Tauri's zoom keys for WKWebView are a page script that
  needs IPC. Windows has no menu bar: WebView2's own keys reload (Ctrl+R, F5), go back and forward
  (Alt+←/→), print (Ctrl+P), find (Ctrl+F), and zoom (Ctrl + / - / 0, Ctrl + wheel:
  `zoom_hotkeys_enabled`).
- **Windows of the app.** Closing the main window on macOS hides it (the app keeps running; the Dock icon
  brings it back; ⌘Q quits), the macOS convention; in full screen it leaves full screen first (hiding it
  there would leave an empty Space). On Windows closing it quits. The main window's size and
  place are remembered (window-state plugin).
- **A page left open across a deploy.** A page loaded before a deploy can't call the new deploy's Server
  Actions (`UnrecognizedActionError`) until it reloads, and a desktop window stays open for days. So when
  the main window comes back after eight hours or more in the background, the shell reloads it (through
  the launcher). Time asleep counts (the wall clock, with the monotonic clock as a fallback if the clock is
  set back), and a deep link that brings the window back is a fresh load already, so it isn't reloaded
  again. A reload replaces the page in the history (Back doesn't land on the same page). Unsent text in an
  open box is lost then, as on any reload. One gap: a Mac put to sleep with the app in front gets no
  "came back" event; it reloads the next time it comes back to the front.

## Notifications and the Dock badge: not built

Skipped on purpose, because neither is cheap without changing the web app:

- The web app has no notification trigger (no Web Notifications, no service worker, no push), and the live
  Inbox message carries ids and flags only, so a notification's text needs another read.
- The unread count is in the sidebar, which isn't mounted when the sidebar is hidden.
- Either would need the hosted pages to call the shell (a remote IPC capability), which is the one thing
  this shell keeps at zero.

The path when it's wanted: move `useUnreadCount` into the always-mounted shell of the web app; when
`window.__ALHC_DESKTOP__` is set, report the count and new items through `tauri-plugin-notification` and
the window's badge API, with a capability limited to `remote.urls: ["https://alhc-projects.vercel.app/*"]`
and those two permissions only; show a notification only while the window isn't focused. On macOS the
window then has to keep running while hidden (it does: close hides it).

## App icon

There is no ALHC logo in the repository: `apps/web/src/app/favicon.ico` is create-next-app's default (the
Vercel triangle), so it isn't usable. The icon is the mark the app itself draws on its sign-in screens
(`apps/web/src/components/auth-card.tsx`): a dark rounded tile (zinc-900, `#18181b`) with a white "A" in
Geist SemiBold, at the tile's own proportions on Apple's 1024 px icon grid. `src-tauri/icons/icon.svg` is
the source (the letter outlined, so no font is needed), and `npm run icons --workspace @alhc/desktop`
regenerates every size (`tauri icon`; the Android and iOS sets are removed). When ALHC has a real logo,
replace `icon.svg` (and the web app's favicon) and rerun it.

## Security

- **No IPC for the hosted pages.** There are no capabilities (`app.security.capabilities: []`) and no
  custom commands, so no page — the hosted app or the launcher — can call a Tauri command or plugin. An XSS
  on the site gets what it gets in a browser, plus nothing.
- **Where a webview may go** is the policy above: the launcher, the app's origin, the app's own signed file
  URLs, and empty frames; everything a person clicks elsewhere goes to the system with a scheme allowlist
  (`https`, `http`, `mailto`, `webcal`, `tel`), rate-limited; `file:`, `data:`, and other schemes never load
  or open. Pages can't put the shell on another site: the app's and its Supabase project's origins are
  compiled in and checked (https, or http on this computer).
- **The launcher's CSP** (`tauri.conf.json` → `app.security.csp`): scripts and styles from the bundle only,
  `connect-src` https (and localhost for development) for the reachability check, no objects, frames, forms,
  or base URL. Tauri's CSP applies to the bundled page, not to the hosted app (whose own headers apply).
- **Deep links** never carry the shell anywhere but the app's own sections (`desktop-links.ts`), and the
  launcher only ever sends the window to `<app origin><path>`.
- **The shell's own scheme** (`alhc-shell://`) can only print the current page.
- **Stored files**: only signed object URLs (`/storage/v1/object/sign/…`) of the app's own Supabase project
  load in a window. Another Supabase project's files (an Asana export's links can point anywhere) or public
  objects would show in a window with no address bar, so they open in the browser like any other site.
  Moving the backend to another Supabase project means a desktop build with `ALHC_SUPABASE_URL`.
- **Logs** never contain a URL beyond its host and first path segment (paths and queries carry tokens:
  review links, calendar feeds, signed files): a failed open logs the scheme and the error's kind, and
  `ALHC_DESKTOP_DEBUG=1` prints the policy's decisions as `scheme://host/first-segment/…`.
- **`freezePrototype` is off.** Tauri runs it on every page of the app's windows, the hosted app included,
  and a frozen `Object.prototype` breaks ordinary code that sets a name like `toString` on a plain object
  (the web app's pdf.js worker URL, so PDF review files wouldn't open). It guards Tauri's own JavaScript
  API, which no page here can use.
- **Release builds** have no developer tools (Tauri's default), the binary is stripped, and the Rust
  dependencies are Tauri and four official plugins (deep link, single instance,
  opener, window state) plus `serde_json` and `url`.

## Auto-update: not set up

The UI comes from the hosted site, so most changes reach desktop users with the next Vercel deploy and no
desktop release. The shell changes rarely; until it does, a new version is a new installer (the release
doc). When automatic updates are wanted: `tauri-plugin-updater` with its own minisign key pair (the private
key as a CI secret, the public key in `tauri.conf.json`), the signed bundles and a `latest.json` on GitHub
Releases (`createUpdaterArtifacts`), and a check at startup. The update signature is separate from Apple's
and Microsoft's code signing, and both are needed. No keys are created in this change.

## CI

- **Every pull request and push to `main`** (`.github/workflows/ci.yml`): the `checks` job lints,
  type-checks, and tests `apps/desktop` with the rest of the workspace (`npm run lint|typecheck|test`); the
  `desktop` job (Ubuntu) builds the launcher page and checks the Rust shell against WebKitGTK: `cargo fmt`,
  clippy in both the development and release configurations, and the policy's tests. About 2–3 minutes
  with the Rust cache, in parallel with the other jobs. It catches shared-code breaks (`desktop-links.ts`
  lives in core) on every change. The Rust release is pinned (`src-tauri/rust-toolchain.toml`, and the
  same version in both workflows), so a new Rust release with new lints can't turn an unrelated pull
  request red; bump it on purpose.
- **Native builds** (`.github/workflows/desktop.yml`): unsigned macOS (Apple silicon `.dmg`) and Windows
  (`.exe` / `.msi`) bundles, uploaded as artifacts for 14 days. They run on pull requests that touch
  `apps/desktop` and by hand (Run workflow). Why not on every PR: they take 10–15 minutes each, and only the
  desktop app's own files change what they compile (the launcher's use of `@alhc/core` is built on every
  PR by `ci.yml`). Why at all:
  the macOS-only and Windows-only code (menus, hide on close, print, downloads, the WebView2 path) only
  compiles there, and the artifacts let anyone try a build without a Mac or a Rust setup. The repository is
  public, so the macOS and Windows runners cost nothing.
- **Not in CI**: signing, notarization, and publishing (docs/desktop-release.md); no secrets are configured.

## Platforms

- **macOS 11.3 (Big Sur) or later** (`minimumSystemVersion`; downloads need WKDownload). The page runs in the
  system WebKit, so Safari must be up to date for the web app (Next.js 16 targets Safari 16.4, which Big Sur
  11.7 and later get as an update). An older engine gets "ALHC Projects needs a newer web engine" from the
  launcher (no `:has()`, `color-mix()`, or RegExp lookbehind, Safari 16.4's JavaScript) instead of a page
  that never starts.
- **Windows 10 and 11** with the WebView2 runtime (built into Windows 11; the installer downloads it when
  missing). Installs per user (no admin rights).
- **Linux**: development builds only (CI and `tauri dev`); not shipped.

## Checking a build by hand

Before the first release, on a Mac and on a Windows PC (the Linux build was checked this way already):

1. First launch: the launcher, then the sign-in page. Offline (Wi-Fi off): "Can't reach ALHC Projects",
   then it opens by itself once back online.
2. Sign in with email and password; quit and reopen: still signed in. "Forgot password?" and "Create an
   account" open in the browser. Sign out works.
3. `alhc://inbox?tab=mentioned` from a browser's address bar (or `open 'alhc://…'` on macOS, `start
   alhc://…` on Windows) opens the Inbox's @Mentioned tab, with the app open and with it closed.
4. A task's attachment: a click downloads it (macOS shows it in Finder); "preview" opens a window with the
   file; an exported CSV downloads.
5. Links: a Google Calendar link opens the browser, a `mailto:` the mail app, a public form an app window.
6. Drag a task on a Board and a file onto the pane's attachments. Print a task (macOS: through the menu and
   the task's Print).
7. macOS: ⌘C / ⌘V in a comment; ⌘W hides, the Dock icon brings the window back; ⌘Q quits. Windows: the
   close button quits.
8. Leave it signed in for more than a week (macOS) and check the session survived.

## What's left

- Google sign-in through the browser (above; after Google is on for the web app).
- Signing, notarization, an installer download page, and automatic updates (docs/desktop-release.md).
- Native notifications and a Dock / taskbar badge (above; needs a small web change).
- Optional: an "Open in desktop app" link in the web app (`desktopLinkFor`), a universal (Intel + Apple
  silicon) macOS build in CI, and a real ALHC logo for the icon and the favicon.
- The phone app (later; not this shell).
