# Releasing the desktop app (Mac and Windows)

How to build, sign, notarize, and hand out ALHC Projects for Mac and Windows (`apps/desktop`; design in
[docs/design/desktop.md](design/desktop.md)). Nothing here is automated yet and no certificate, account,
or secret exists for it: each step below says what to get and where it goes.

Why sign at all: an unsigned Mac app is blocked by Gatekeeper ("can't be opened because Apple cannot
check it for malicious software"), and an unsigned Windows installer shows SmartScreen's "Windows protected
your PC". People can get past both, but that's no way to ship to a team.

The app shows the hosted web app, so a new desktop release is only needed when the shell itself changes
(`apps/desktop`), not for web app changes.

## 0. Before every release

1. Bump `version` in `apps/desktop/package.json` (the app's version comes from there:
   `tauri.conf.json` → `"version": "../package.json"`). Windows' MSI needs plain `major.minor.patch`.
2. Merge to `main` with CI green.
3. Check the Mac and Windows builds of that commit (Actions → **Desktop builds**: they run on pull requests
   that touch the desktop app, or **Run workflow**) and go through "Checking a build by hand" in the design
   doc once on each platform.
4. Build on a clean checkout of that commit:

   ```bash
   git switch main && git pull
   npm ci
   ```

Tools on the build machine: Node 22, `rustup` (`apps/desktop/src-tauri/rust-toolchain.toml` picks the Rust
release, and rustup installs it on the first build), and the platform's tools below.

## 1. macOS: sign and notarize

### One-time setup

1. **Apple Developer Program** membership for Autumn Lake (an organization account; it needs the D-U-N-S
   number; currently $99 a year): https://developer.apple.com/programs/
2. **Developer ID Application certificate** (for apps distributed outside the App Store). Create it in
   Xcode (Settings → Accounts → the team → Manage Certificates → + → Developer ID Application) or on
   developer.apple.com → Certificates. Only the Account Holder can create Developer ID certificates. It
   lands in the Mac's login keychain; check with:

   ```bash
   security find-identity -v -p codesigning
   # → "Developer ID Application: Autumn Lake (TEAMID1234)"
   ```

3. **Notarization credentials**, one of:
   - an **App Store Connect API key** (App Store Connect → Users and Access → Integrations → Keys, role
     Developer): the key id, the issuer id, and the downloaded `AuthKey_<id>.p8` file; or
   - the Apple ID's email, an **app-specific password** (appleid.apple.com → Sign-In and Security), and
     the team id.
4. Xcode or the Command Line Tools (`xcode-select --install`), and both Rust targets for a universal
   build (Apple silicon and Intel), added to the pinned Rust release (rustup keeps targets per release:
   from the repository root they would go to `stable` instead). Run it again after bumping
   `rust-toolchain.toml`:

   ```bash
   (cd apps/desktop/src-tauri && rustup target add aarch64-apple-darwin x86_64-apple-darwin)
   ```

### Build

Tauri signs (with the hardened runtime), notarizes, and staples the app by itself when these are set:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Autumn Lake (TEAMID1234)"
# Notarization with an API key …
export APPLE_API_ISSUER="<issuer id>"
export APPLE_API_KEY="<key id>"
export APPLE_API_KEY_PATH="$HOME/private_keys/AuthKey_<key id>.p8"
# … or with an Apple ID:
# export APPLE_ID="you@autumnlakemarketing.com" APPLE_PASSWORD="<app-specific password>" APPLE_TEAM_ID="TEAMID1234"

npm run build --workspace @alhc/desktop -- --target universal-apple-darwin --bundles app,dmg
```

Output: `apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/ALHC Projects_<version>_universal.dmg`
(and the `.app` next to it under `bundle/macos`). Notarization usually takes a few minutes; Tauri waits for it.

### Check it

```bash
APP="apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/ALHC Projects.app"
codesign --verify --deep --strict --verbose=2 "$APP"
spctl --assess --type execute --verbose "$APP"        # → accepted, source=Notarized Developer ID
xcrun stapler validate "$APP"
```

Then copy the `.dmg` to another Mac (or download it from wherever it's published), open it, drag the app
to Applications, and open it: no warning should appear. `alhc://` links work once the app has been opened
from Applications once.

## 2. Windows: sign

### One-time setup: a code-signing certificate

Since 2023 the private key of a publicly trusted code-signing certificate must live in hardware (a USB
token or a cloud HSM), so there is no `.pfx` file to copy around. Choose one:

- **Azure Trusted Signing** (Microsoft's cloud signing service; recommended if Autumn Lake qualifies:
  Microsoft verifies the organization, and the price is a small monthly fee — check the current
  eligibility rules and price on the Azure page). You get an Azure account, a Trusted Signing account, and
  a certificate profile; signing runs through `trusted-signing-cli` (Tauri's documented route).
- **An OV or EV certificate from a CA** (DigiCert, Sectigo, SSL.com, …) delivered on a USB token, or held
  in the CA's cloud signing service. Signing runs on the machine with the token, through `signtool`.

SmartScreen still warns for a new certificate until it has built up reputation (downloads over time);
an EV certificate no longer skips that. Either way, sign every release with the same certificate.

### Build

Put the signing settings in a small config file next to `tauri.conf.json`, which the build merges in:
`apps/desktop/src-tauri/tauri.signing.conf.json`. It holds no secret (names and a thumbprint), so it can be
committed once settled.

**With Azure Trusted Signing.** Install the signer once (`cargo install trusted-signing-cli`) and use:

```json
{
  "bundle": {
    "windows": {
      "signCommand": {
        "cmd": "trusted-signing-cli",
        "args": [
          "-e", "https://<region>.codesigning.azure.net",
          "-a", "<account>",
          "-c", "<certificate profile>",
          "-d", "ALHC Projects",
          "%1"
        ]
      }
    }
  }
}
```

(The object form, because Tauri splits the one-string form on spaces with no shell: quotes don't keep
"ALHC Projects" together there.)

The signer reads the Azure credentials of a service principal allowed to sign from the environment:

```powershell
$env:AZURE_CLIENT_ID = "<id>"; $env:AZURE_CLIENT_SECRET = "<secret>"; $env:AZURE_TENANT_ID = "<tenant>"
npm run build --workspace @alhc/desktop -- --bundles nsis,msi --config src-tauri/tauri.signing.conf.json
```

**With a certificate on a token** (installed in the Windows certificate store), give its thumbprint and
your CA's timestamp server instead:

```json
{
  "bundle": {
    "windows": {
      "certificateThumbprint": "<thumbprint>",
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com"
    }
  }
}
```

```powershell
npm run build --workspace @alhc/desktop -- --bundles nsis,msi --config src-tauri/tauri.signing.conf.json
```

Output: `apps/desktop/src-tauri/target/release/bundle/nsis/ALHC Projects_<version>_x64-setup.exe` (installs
for the current user, no admin rights; downloads the WebView2 runtime when it's missing) and
`…/bundle/msi/ALHC Projects_<version>_x64_en-US.msi` (for IT tools such as Intune).

### Check it

```powershell
Get-AuthenticodeSignature ".\apps\desktop\src-tauri\target\release\bundle\nsis\ALHC Projects_<version>_x64-setup.exe"
# Status: Valid, SignerCertificate: CN=Autumn Lake…
```

Install it on another PC, open it, try an `alhc://inbox` link (Win+R → `alhc://inbox`).

## 3. Hand it out

- **GitHub Releases** on this repository (it's public, so the installers are too; that's fine: the app
  holds no secret and only allowlisted people can sign in). Tag the commit `desktop-v<version>`, create a
  release, attach the `.dmg`, the `-setup.exe`, and the `.msi`, and list what changed in the shell.
- Or a shared drive / a page of Autumn Lake's site, or the company's device management (Intune takes the
  `.msi`; Jamf / Kandji take the `.dmg` or the `.app`).
- Tell people: macOS — open the `.dmg`, drag ALHC Projects to Applications. Windows — run the setup. Both:
  sign in with the same email and password as on the web. Forgot your password? Reset it in the browser,
  then sign in here.

## 4. Later: automate it

When releases become regular, a `release-desktop.yml` workflow (on a `desktop-v*` tag) can do sections 1–3
on GitHub's macOS and Windows runners (`tauri-apps/tauri-action` builds, signs, notarizes, and drafts the
release). It needs these repository secrets, none of which exist today:

| Secret | For |
| --- | --- |
| `APPLE_CERTIFICATE` (the Developer ID certificate exported as `.p12`, base64), `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD` | importing the certificate on the Mac runner |
| `APPLE_SIGNING_IDENTITY` | which identity signs |
| `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8` (the `.p8` contents) | notarization |
| `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` (+ the account and profile names) | Windows signing with Trusted Signing |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | only with automatic updates (below) |

Automatic updates (not set up; see the design doc): `npm run tauri --workspace @alhc/desktop -- signer
generate -w ~/.tauri/alhc-desktop.key` makes the update key pair; the public key goes into
`tauri.conf.json` (`plugins.updater.pubkey`) with `bundle.createUpdaterArtifacts: true` and the
`tauri-plugin-updater` plugin, and the private key is a secret. Keep it safe: lose it and installed apps
can't be updated any more.

## Where the app keeps its data

Signing out is enough for a shared machine. To start completely fresh (sign-in, window size), sign out
first (so the server ends the session even if a cookie survives), then:

- macOS: quit the app, then remove `~/Library/WebKit/com.autumnlakemarketing.alhcprojects`,
  `~/Library/HTTPStorages/com.autumnlakemarketing.alhcprojects` and the
  `com.autumnlakemarketing.alhcprojects.binarycookies` file next to it (the cookies),
  `~/Library/Caches/com.autumnlakemarketing.alhcprojects`, and
  `~/Library/Application Support/com.autumnlakemarketing.alhcprojects` (the window size).
- Windows: uninstall (Settings → Apps), then remove `%LOCALAPPDATA%\com.autumnlakemarketing.alhcprojects`
  (the sign-in) and `%APPDATA%\com.autumnlakemarketing.alhcprojects` (the window size). The NSIS
  uninstaller's "Delete the application data" box does both; the MSI's has no such box.
