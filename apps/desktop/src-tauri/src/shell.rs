//! The desktop app's windows (docs/design/desktop.md): the main window (the launcher, then the hosted app)
//! and the windows pages open (file previews, public forms). Every webview gets the same page script, the
//! navigation policy (`policy.rs`), the new-window rule, and the download handling.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::policy::{self, Navigation, NewWindow, Policy, WindowKind};

pub const MAIN: &str = "main";
const TITLE: &str = "ALHC Projects";
const PAGE_SCRIPT: &str = include_str!("page.js");

/// After this long in the background the main window reloads when it comes back: a page loaded before a
/// deploy can't call the new deploy's Server Actions, and a desktop window stays open for days.
const STALE_AFTER: Duration = Duration::from_secs(8 * 60 * 60);

/// How long a stale reload waits, so a deep link that brought the window back (macOS may report the focus
/// before the link) wins.
const STALE_RELOAD_DELAY: Duration = Duration::from_millis(300);

/// How long Reload waits for the page to confirm it replaced itself with the launcher before loading the
/// launcher from the shell instead (a page whose web process died, or that's stuck, runs no script).
const RELOAD_FALLBACK_AFTER: Duration = Duration::from_millis(1500);

/// macOS: how long after the last resize of a full-screen exit the main window is hidden. tao reports a
/// resize during the exit animation as well as at its end (and its full-screen state reads "not full
/// screen" as soon as the exit is asked for), so the hide waits for the resizes to stop.
#[cfg(target_os = "macos")]
const HIDE_AFTER_FULLSCREEN_EXIT: Duration = Duration::from_millis(1000);

/// When the main window went to the background, on two clocks: the wall clock keeps counting while the
/// computer sleeps (a laptop spends most of a weekend asleep; `Instant` doesn't count that on macOS or
/// Linux), and `Instant` still counts if the wall clock is set back.
#[derive(Clone, Copy, Debug)]
struct Since {
    instant: Instant,
    wall: SystemTime,
}

impl Since {
    fn now() -> Self {
        Self {
            instant: Instant::now(),
            wall: SystemTime::now(),
        }
    }

    fn stale_at(self, now: Since) -> bool {
        now.instant.saturating_duration_since(self.instant) >= STALE_AFTER
            || now.wall.duration_since(self.wall).unwrap_or_default() >= STALE_AFTER
    }
}

/// Page zoom from the View menu (macOS, and Linux development builds): WebView2 zooms by itself
/// (Ctrl + / - / 0, `zoom_hotkeys_enabled`), but Tauri's zoom keys for WKWebView and WebKitGTK are a page
/// script that needs IPC, which pages don't get. Safari's steps.
#[cfg(not(windows))]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Zoom {
    In,
    Out,
    Reset,
}

#[cfg(not(windows))]
const ZOOM_LEVELS: [f64; 11] = [0.5, 0.75, 0.85, 1.0, 1.15, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

#[cfg(not(windows))]
fn zoom_level(current: f64, step: Zoom) -> f64 {
    const CLOSE: f64 = 0.001;
    match step {
        Zoom::Reset => 1.0,
        Zoom::In => ZOOM_LEVELS
            .into_iter()
            .find(|level| *level > current + CLOSE)
            .unwrap_or(ZOOM_LEVELS[ZOOM_LEVELS.len() - 1]),
        Zoom::Out => ZOOM_LEVELS
            .into_iter()
            .rev()
            .find(|level| *level < current - CLOSE)
            .unwrap_or(ZOOM_LEVELS[0]),
    }
}

pub struct Shell {
    pub policy: Policy,
    launcher: Url,
    page_script: String,
    popups: AtomicU32,
    external: Mutex<policy::ExternalGate>,
    background_since: Mutex<Option<Since>>,
    #[cfg(not(windows))]
    downloads: Mutex<std::collections::HashMap<String, std::path::PathBuf>>,
    /// Each window's zoom (webviews can set it but not report it).
    #[cfg(not(windows))]
    zoom: Mutex<std::collections::HashMap<String, f64>>,
    /// Counts deep links, so a stale reload scheduled just before one is dropped.
    links: AtomicU64,
    /// macOS: the main window was closed in full screen and is hidden once it has left it; the resizes
    /// seen since, so only the last one's timer hides it.
    #[cfg(target_os = "macos")]
    hide_after_fullscreen: AtomicBool,
    #[cfg(target_os = "macos")]
    fullscreen_resizes: AtomicU64,
}

/// Where the launcher page is served: the Vite dev server under `tauri dev`, else the app's own protocol
/// (`tauri://localhost`, or `http://tauri.localhost` on Windows).
fn launcher_base(app: &AppHandle) -> Url {
    #[cfg(dev)]
    if let Some(url) = &app.config().build.dev_url {
        return url.clone();
    }
    let _ = app;
    let base = if cfg!(windows) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    Url::parse(base).expect("a static URL")
}

impl Shell {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let launcher = launcher_base(app);
        let app_url = option_env!("ALHC_APP_URL").unwrap_or(policy::DEFAULT_APP_URL);
        let supabase_url = option_env!("ALHC_SUPABASE_URL").unwrap_or(policy::DEFAULT_SUPABASE_URL);
        let policy = Policy::new(app_url, supabase_url, std::slice::from_ref(&launcher))?;
        let info = serde_json::json!({
            "appOrigin": policy.app_origin(),
            "platform": std::env::consts::OS,
            "version": app.package_info().version.to_string(),
        });
        Ok(Self {
            page_script: PAGE_SCRIPT.replace("__ALHC_DESKTOP_INFO__", &info.to_string()),
            policy,
            launcher,
            popups: AtomicU32::new(0),
            external: Mutex::new(policy::ExternalGate::default()),
            background_since: Mutex::new(None),
            #[cfg(not(windows))]
            downloads: Mutex::new(Default::default()),
            #[cfg(not(windows))]
            zoom: Mutex::new(Default::default()),
            links: AtomicU64::new(0),
            #[cfg(target_os = "macos")]
            hide_after_fullscreen: AtomicBool::new(false),
            #[cfg(target_os = "macos")]
            fullscreen_resizes: AtomicU64::new(0),
        })
    }

    pub fn launcher_url(&self, key: &str, value: &str) -> Url {
        policy::launcher_url(&self.launcher, key, value)
    }
}

fn shell(app: &AppHandle) -> tauri::State<'_, Shell> {
    app.state::<Shell>()
}

/// Run `then` on the main thread after `delay`.
fn later(app: &AppHandle, delay: Duration, then: impl FnOnce(&AppHandle) + Send + 'static) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        let target = app.clone();
        let _ = target.run_on_main_thread(move || then(&app));
    });
}

/// Hand a URL to the system: the browser, the mail app, a calendar app. Never logs the URL (signed file
/// links carry tokens).
pub fn open_externally(app: &AppHandle, url: &Url) {
    if !policy::opens_externally(url) {
        return;
    }
    let allowed = shell(app)
        .external
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .allow(url.as_str(), Instant::now());
    if !allowed {
        return;
    }
    // The error's text can quote the whole command line, URL included: log its kind only.
    if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
        let kind = match &error {
            tauri_plugin_opener::Error::Io(e) => format!("{:?}", e.kind()),
            _ => "error".to_string(),
        };
        eprintln!(
            "alhc-desktop: couldn't open a {} link ({kind})",
            url.scheme()
        );
    }
}

/// `ALHC_DESKTOP_DEBUG=1` prints each navigation decision, for troubleshooting the policy: the scheme,
/// the host, and the path's first segment only (paths and queries can carry tokens: review links,
/// calendar feeds, signed files).
fn trace(what: &str, label: &str, url: &Url, decision: &dyn std::fmt::Debug) {
    if std::env::var_os("ALHC_DESKTOP_DEBUG").is_some() {
        let host = url.host_str().unwrap_or("");
        let first = url
            .path()
            .trim_start_matches('/')
            .split('/')
            .next()
            .unwrap_or("");
        let more = if url.path().trim_start_matches('/').contains('/') {
            "/…"
        } else {
            ""
        };
        eprintln!(
            "alhc-desktop: {what} [{label}] {}://{host}/{first}{more} → {decision:?}",
            url.scheme()
        );
    }
}

fn navigate(app: &AppHandle, label: &str, kind: WindowKind, url: &Url) -> bool {
    let decision = shell(app).policy.navigation(url, kind);
    trace("navigation", label, url, &decision);
    match decision {
        Navigation::Allow => true,
        Navigation::OpenExternally => {
            open_externally(app, url);
            false
        }
        Navigation::Print => {
            // After the navigation is cancelled: printing opens a sheet over the window.
            let (app, label) = (app.clone(), label.to_string());
            let target = app.clone();
            let _ = target.run_on_main_thread(move || {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.print();
                }
            });
            false
        }
        Navigation::Ignore => false,
    }
}

fn new_window(app: &AppHandle, url: Url, features: NewWindowFeatures) -> NewWindowResponse<Wry> {
    let decision = shell(app).policy.new_window(&url);
    trace("new window", "", &url, &decision);
    match decision {
        NewWindow::InApp => match open_popup(app, features) {
            Ok(window) => NewWindowResponse::Create { window },
            Err(error) => {
                eprintln!("alhc-desktop: couldn't open a window: {error}");
                NewWindowResponse::Deny
            }
        },
        NewWindow::OpenExternally => {
            open_externally(app, &url);
            NewWindowResponse::Deny
        }
        NewWindow::Ignore => NewWindowResponse::Deny,
    }
}

/// What every window of the app gets.
fn window_builder<'a>(
    app: &'a AppHandle,
    label: &str,
    url: WebviewUrl,
    kind: WindowKind,
) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    let script = shell(app).page_script.clone();
    let (nav_app, nav_label) = (app.clone(), label.to_string());
    let popup_app = app.clone();
    let builder = WebviewWindowBuilder::new(app, label, url)
        .title(TITLE)
        // Tauri's file-drop capture would break the app's HTML drag and drop (List, Board, uploads).
        .disable_drag_drop_handler()
        .initialization_script(script)
        .on_navigation(move |url| navigate(&nav_app, &nav_label, kind, url))
        .on_new_window(move |url, features| new_window(&popup_app, url, features))
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(if title.trim().is_empty() {
                TITLE
            } else {
                &title
            });
        });
    // WebView2's own zoom (Ctrl + / - / 0, Ctrl + wheel). Elsewhere this would inject Tauri's zoom script,
    // whose IPC call pages aren't allowed: zoom is the View menu's there (see Zoom).
    #[cfg(windows)]
    let builder = builder.zoom_hotkeys_enabled(true);
    with_downloads(app, builder)
}

/// Windows: WebView2 saves downloads and shows its own downloads list, so it's left to do that. macOS and
/// Linux: the file goes to the Downloads folder (deduplicated names) and is shown in Finder / the file
/// manager when it's done.
#[cfg(not(windows))]
fn with_downloads<'a>(
    app: &AppHandle,
    builder: WebviewWindowBuilder<'a, Wry, AppHandle>,
) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    use tauri::webview::DownloadEvent;
    let app = app.clone();
    builder.on_download(move |_webview, event| {
        let state = shell(&app);
        let mut downloads = state.downloads.lock().unwrap_or_else(|e| e.into_inner());
        match event {
            DownloadEvent::Requested { url, destination } => {
                downloads.insert(url.to_string(), destination.clone());
            }
            DownloadEvent::Finished { url, path, success } => {
                let saved = downloads.remove(url.as_str());
                if success {
                    if let Some(file) = path.or(saved) {
                        let _ = app.opener().reveal_item_in_dir(file);
                    }
                }
            }
            _ => {}
        }
        true
    })
}

#[cfg(windows)]
fn with_downloads<'a>(
    _app: &AppHandle,
    builder: WebviewWindowBuilder<'a, Wry, AppHandle>,
) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    builder
}

/// The main window, on the launcher (with the deep link the app was opened with, if any).
pub fn open_main(app: &AppHandle, link: Option<&Url>) -> tauri::Result<WebviewWindow> {
    let page = match link {
        Some(link) => format!(
            "index.html?{}",
            url::form_urlencoded::Serializer::new(String::new())
                .append_pair("open", link.as_str())
                .finish()
        ),
        None => "index.html".to_string(),
    };
    window_builder(app, MAIN, WebviewUrl::App(page.into()), WindowKind::Main)
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .build()
}

/// A window a page asked for. On macOS, Windows, and Linux it must share the opener's web configuration,
/// so it shares the session (window_features does that).
fn open_popup(app: &AppHandle, features: NewWindowFeatures) -> tauri::Result<WebviewWindow> {
    let label = format!(
        "popup-{}",
        shell(app).popups.fetch_add(1, Ordering::Relaxed) + 1
    );
    window_builder(
        app,
        &label,
        WebviewUrl::External("about:blank".parse().expect("a static URL")),
        WindowKind::Popup,
    )
    .inner_size(1000.0, 760.0)
    .min_inner_size(400.0, 300.0)
    .window_features(features)
    .build()
}

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

pub fn show(window: &WebviewWindow) {
    // Shown again before a full-screen close finished hiding it: it stays.
    #[cfg(target_os = "macos")]
    if window.label() == MAIN {
        shell(window.app_handle())
            .hide_after_fullscreen
            .store(false, Ordering::SeqCst);
    }
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Open a deep link (alhc://…) in the main window, through the launcher.
pub fn open_link(app: &AppHandle, link: &Url) {
    if !policy::is_deep_link(link) {
        return;
    }
    match main_window(app) {
        Some(window) => {
            // The launcher loads the app afresh, so coming back to the front now (show) mustn't also
            // count as a return after a long time away: that reload would replace the linked page.
            // (A stale reload already scheduled is dropped too: `links`.)
            shell(app).links.fetch_add(1, Ordering::SeqCst);
            *shell(app)
                .background_since
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = None;
            let _ = window.navigate(shell(app).launcher_url("open", link.as_str()));
            show(&window);
        }
        None => {
            if let Ok(window) = open_main(app, Some(link)) {
                show(&window);
            }
        }
    }
}

/// Reload through the launcher, so a page that can't load shows "Can't reach ALHC Projects" with a retry
/// instead of the webview's error page. Anything that isn't an app page (the launcher, a file) reloads in
/// place. The page replaces itself with the launcher (which replaces itself with the page again): a load
/// from the shell (navigate) would add a history entry, and Back would land on the same page. If the page
/// doesn't confirm it ran that (its web process died, or it's stuck), the shell loads the launcher itself.
pub fn reload(app: &AppHandle, window: &WebviewWindow) {
    let current = window.url().ok();
    let path = current
        .as_ref()
        .and_then(|url| shell(app).policy.app_path(url));
    match path {
        Some(path) if window.label() == MAIN => {
            let launcher = shell(app).launcher_url("to", &path);
            let script = format!(
                "location.replace({}); \"replaced\"",
                serde_json::Value::from(launcher.as_str())
            );
            let replaced = Arc::new(AtomicBool::new(false));
            let ran = Arc::clone(&replaced);
            let asked = window.eval_with_callback(script, move |result| {
                if result.contains("replaced") {
                    ran.store(true, Ordering::SeqCst);
                }
            });
            if asked.is_err() {
                let _ = window.navigate(launcher);
                return;
            }
            let window = window.clone();
            later(app, RELOAD_FALLBACK_AFTER, move |_| {
                if !replaced.load(Ordering::SeqCst) {
                    let _ = window.navigate(launcher);
                }
            });
        }
        _ => {
            let _ = window.eval("location.reload()");
        }
    }
}

/// The main window went to the background or came back (see STALE_AFTER).
pub fn focus_changed(app: &AppHandle, window: &WebviewWindow, focused: bool) {
    if window.label() != MAIN {
        return;
    }
    let state = shell(app);
    let mut since = state
        .background_since
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if !focused {
        since.get_or_insert_with(Since::now);
        return;
    }
    if since.take().is_some_and(|at| at.stale_at(Since::now())) {
        drop(since);
        let links = state.links.load(Ordering::SeqCst);
        let window = window.clone();
        later(app, STALE_RELOAD_DELAY, move |app| {
            if shell(app).links.load(Ordering::SeqCst) == links {
                reload(app, &window);
            }
        });
    }
}

/// View → Zoom In / Zoom Out / Actual Size, for the window the menu acts on.
#[cfg(not(windows))]
pub fn zoom(app: &AppHandle, window: &WebviewWindow, step: Zoom) {
    let state = shell(app);
    let mut levels = state.zoom.lock().unwrap_or_else(|e| e.into_inner());
    let level = zoom_level(levels.get(window.label()).copied().unwrap_or(1.0), step);
    if window.set_zoom(level).is_ok() {
        levels.insert(window.label().to_string(), level);
    }
}

/// A window closed for good: forget what the shell kept about it (a new main window starts at 100%).
pub fn forget_window(app: &AppHandle, label: &str) {
    #[cfg(not(windows))]
    shell(app)
        .zoom
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(label);
    #[cfg(windows)]
    let _ = (app, label);
}

/// macOS: closing the main window hides it; in full screen it leaves full screen first (hiding a window
/// there leaves an empty, black Space) and is hidden once that's done (`resized_main`).
#[cfg(target_os = "macos")]
pub fn hide_main(app: &AppHandle, window: &WebviewWindow) {
    if window.is_fullscreen().unwrap_or(false) {
        shell(app)
            .hide_after_fullscreen
            .store(true, Ordering::SeqCst);
        if window.set_fullscreen(false).is_ok() {
            return;
        }
        shell(app)
            .hide_after_fullscreen
            .store(false, Ordering::SeqCst);
    }
    let _ = window.hide();
}

/// macOS: while a full-screen close is pending, each resize restarts the wait; the last one comes when
/// the window has left full screen (tao's windowDidExitFullScreen), and the window is hidden a moment
/// after it (HIDE_AFTER_FULLSCREEN_EXIT).
#[cfg(target_os = "macos")]
pub fn resized_main(app: &AppHandle, window: &WebviewWindow) {
    let state = shell(app);
    if !state.hide_after_fullscreen.load(Ordering::SeqCst) {
        return;
    }
    let resize = state.fullscreen_resizes.fetch_add(1, Ordering::SeqCst) + 1;
    let window = window.clone();
    later(app, HIDE_AFTER_FULLSCREEN_EXIT, move |app| {
        let state = shell(app);
        if state.fullscreen_resizes.load(Ordering::SeqCst) == resize
            && state.hide_after_fullscreen.swap(false, Ordering::SeqCst)
        {
            let _ = window.hide();
        }
    });
}

/// The page shown in the window, if it's an app page (for "Open in Browser").
#[cfg(not(windows))]
pub fn app_url(app: &AppHandle, window: &WebviewWindow) -> Option<Url> {
    window
        .url()
        .ok()
        .filter(|url| shell(app).policy.is_app(url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_after_eight_hours_awake_asleep_or_with_the_clock_set_back() {
        let at = Since::now();
        let later = |awake: u64, wall: i64| Since {
            instant: at.instant + Duration::from_secs(awake),
            wall: if wall >= 0 {
                at.wall + Duration::from_secs(wall.unsigned_abs())
            } else {
                at.wall - Duration::from_secs(wall.unsigned_abs())
            },
        };
        let hours = |h: u64| h * 60 * 60;
        // A few minutes away: not stale.
        assert!(!at.stale_at(later(300, 300)));
        // Eight hours in the background, awake.
        assert!(at.stale_at(later(hours(8), hours(8) as i64)));
        // A weekend with the lid closed: minutes awake, days on the wall clock.
        assert!(at.stale_at(later(600, hours(60) as i64)));
        // The wall clock set back an hour during a long day: the monotonic clock still counts.
        assert!(at.stale_at(later(hours(9), -(hours(1) as i64))));
        // Just under eight hours on both.
        assert!(!at.stale_at(later(hours(8) - 1, hours(8) as i64 - 1)));
    }

    #[cfg(not(windows))]
    #[test]
    fn zoom_steps_like_safari_and_stops_at_the_ends() {
        assert_eq!(zoom_level(1.0, Zoom::In), 1.15);
        assert_eq!(zoom_level(1.0, Zoom::Out), 0.85);
        assert_eq!(zoom_level(1.15, Zoom::Out), 1.0);
        assert_eq!(zoom_level(3.0, Zoom::In), 3.0);
        assert_eq!(zoom_level(0.5, Zoom::Out), 0.5);
        assert_eq!(zoom_level(2.5, Zoom::Reset), 1.0);
        // A level between steps goes to the next one.
        assert_eq!(zoom_level(1.2, Zoom::In), 1.25);
        assert_eq!(zoom_level(1.2, Zoom::Out), 1.15);
    }
}
