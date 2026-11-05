// Runs at the start of every page in the desktop app's windows (src/shell.rs → initialization_script): the
// launcher and the hosted web app. It tells the page it's in the desktop app and covers a few webview gaps.
// It uses no Tauri IPC (the shell gives remote pages none); the shell's navigation policy does the rest.
(() => {
  const info = Object.freeze(__ALHC_DESKTOP_INFO__);
  Object.defineProperty(window, "__ALHC_DESKTOP__", { value: info });
  if (location.origin !== info.appOrigin) return;

  // Link clicks, before the page's own handlers (the capture phase: Next.js would take the click first).
  // 1. A file (/attachments/<id>, /review-files/<id>; not a preview) is a download, never a page: WKWebView
  //    would show an image or PDF in place of the app, and a new window for a download stays blank.
  // 2. Sign-up and password reset finish in the system browser (their email links only work in the browser
  //    that asked). Next.js links change pages without a load, which the shell can't see, so these become
  //    real loads, which the shell hands to the browser.
  // Links for a new window (target="_blank", ⌘/Ctrl-click) need nothing here: WKWebView and WebView2 ask
  // the shell for the window. (WebKitGTK, Linux development builds only, drops them.)
  const FILE = /^\/(attachments|review-files)\/[^/]+$/;
  const BROWSER_ONLY = /^\/(signup|forgot-password)(\/|$)/;
  const download = (href) => {
    const link = document.createElement("a");
    link.href = href;
    link.download = "";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  };
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download")) return;
      const url = new URL(link.href, document.baseURI);
      if (url.origin !== location.origin) return;
      if (FILE.test(url.pathname) && !url.searchParams.has("preview") && !url.searchParams.has("media")) {
        event.preventDefault();
        download(url.href);
      } else if (BROWSER_ONLY.test(url.pathname)) {
        event.preventDefault();
        location.assign(url.href);
      }
    },
    true,
  );

  // WKWebView (macOS) ignores window.print(). Ask the shell instead: it cancels the load of its own
  // alhc-shell://print and prints the page. When printing ends can't be known, so "afterprint" (the app's
  // Print task uses it) goes out with the next click or key press; it only affects print styles.
  if (info.platform === "macos") {
    let printing = false;
    const printed = () => {
      if (!printing) return;
      printing = false;
      window.dispatchEvent(new Event("afterprint"));
    };
    window.addEventListener("pointerdown", printed, true);
    window.addEventListener("keydown", printed, true);
    const print = () => {
      printed();
      window.dispatchEvent(new Event("beforeprint"));
      location.href = "alhc-shell://print";
      setTimeout(() => {
        printing = true;
      }, 0);
    };
    Object.defineProperty(window, "print", { value: print, configurable: true, writable: true });
  }
})();
