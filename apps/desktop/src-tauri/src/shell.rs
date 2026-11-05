//! The desktop app's windows (docs/design/desktop.md): the main window (the launcher, then the hosted app)
//! and the windows pages open (file previews, public forms). Every webview gets the same page script, the
//! navigation policy (`policy.rs`), the new-window rule, and the download handling.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

pub struct Shell {
    pub policy: Policy,
    launcher: Url,
    page_script: String,
    popups: AtomicU32,
    external: Mutex<policy::ExternalGate>,
    background_since: Mutex<Option<Instant>>,
    #[cfg(not(windows))]
    downloads: Mutex<std::collections::HashMap<String, std::path::PathBuf>>,
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
        })
    }

    pub fn launcher_url(&self, key: &str, value: &str) -> Url {
        policy::launcher_url(&self.launcher, key, value)
    }
}

fn shell(app: &AppHandle) -> tauri::State<'_, Shell> {
    app.state::<Shell>()
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
        .zoom_hotkeys_enabled(true)
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
/// place.
pub fn reload(app: &AppHandle, window: &WebviewWindow) {
    let current = window.url().ok();
    let path = current
        .as_ref()
        .and_then(|url| shell(app).policy.app_path(url));
    match path {
        Some(path) if window.label() == MAIN => {
            let _ = window.navigate(shell(app).launcher_url("to", &path));
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
        since.get_or_insert_with(Instant::now);
        return;
    }
    if since.take().is_some_and(|at| at.elapsed() >= STALE_AFTER) {
        drop(since);
        reload(app, window);
    }
}

/// The page shown in the window, if it's an app page (for "Open in Browser").
pub fn app_url(app: &AppHandle, window: &WebviewWindow) -> Option<Url> {
    window
        .url()
        .ok()
        .filter(|url| shell(app).policy.is_app(url))
}
