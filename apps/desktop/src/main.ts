// The launcher page's DOM (docs/design/desktop.md): "Opening ALHC Projects…", then the app; or "Can't reach
// ALHC Projects" with automatic retries and a Try again button. No Tauri API is used: the page needs no IPC.
import { engineTooOld, launchTarget, probeUrl, readShellInfo, retryDelaySeconds, type ShellInfo } from "./launcher";

const PROBE_TIMEOUT_MS = 10_000;

const status = document.getElementById("status") as HTMLParagraphElement;
const detail = document.getElementById("detail") as HTMLParagraphElement;
const retry = document.getElementById("retry") as HTMLButtonElement;

function show(title: string, text: string, canRetry: boolean) {
  status.textContent = title;
  detail.textContent = text;
  detail.hidden = !text;
  retry.hidden = !canRetry;
}

async function reachable(url: string): Promise<boolean> {
  if (!navigator.onLine) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", credentials: "omit", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function startLauncher(shell: ShellInfo) {
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  async function connect() {
    if (running) return;
    running = true;
    clearTimeout(timer);
    show("Opening ALHC Projects…", "", false);
    const ok = await reachable(probeUrl(shell.appOrigin));
    running = false;
    if (ok) {
      location.replace(launchTarget(location.search, shell.appOrigin));
      return;
    }
    failures += 1;
    const seconds = retryDelaySeconds(failures);
    show(
      "Can’t reach ALHC Projects",
      `Check your internet connection. The app needs to be online. Trying again in ${seconds} seconds.`,
      true,
    );
    timer = setTimeout(connect, seconds * 1000);
  }

  retry.addEventListener("click", () => void connect());
  window.addEventListener("online", () => void connect());
  void connect();
}

const shell = readShellInfo((window as Window & { __ALHC_DESKTOP__?: unknown }).__ALHC_DESKTOP__);
if (!shell) show("This page belongs to the ALHC Projects desktop app.", "Open the app to use it.", false);
else if (engineTooOld((property, value) => (value === undefined ? CSS.supports(property) : CSS.supports(property, value))))
  show(
    "ALHC Projects needs a newer web engine",
    shell.platform === "macos"
      ? "Install the latest Safari or macOS update from Software Update (System Preferences, or System Settings → General on macOS 13 and later), then open the app again."
      : "Update Microsoft Edge WebView2 (or Windows), then open the app again.",
    false,
  );
else startLauncher(shell);
