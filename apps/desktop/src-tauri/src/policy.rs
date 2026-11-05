//! Where the desktop app's webviews may go (docs/design/desktop.md → Security). Pure rules, unit-tested;
//! `shell.rs` applies them to every navigation and every new-window request.
//!
//! A window shows the launcher page (bundled with the app) or the hosted web app. Everything else either
//! opens in the system browser / mail app (links people click) or doesn't load at all. The hosted pages
//! get no Tauri IPC at all (there are no capabilities), so this policy is the whole surface they have.

use url::Url;

/// The hosted web app. A build can point elsewhere with `ALHC_APP_URL` (e.g. `http://localhost:3000`
/// while developing the web app); it must be https, or http on this computer.
pub const DEFAULT_APP_URL: &str = "https://alhc-projects.vercel.app";

/// The app's Supabase project (the web app's `NEXT_PUBLIC_SUPABASE_URL`): `/attachments/<id>` and the
/// review routes redirect to short-lived signed file URLs there. `ALHC_SUPABASE_URL` overrides it.
pub const DEFAULT_SUPABASE_URL: &str = "https://xsgmawawwstbrbukgsax.supabase.co";

/// Where those signed file URLs live (`createSignedUrl`). Public objects (avatars, logos) are images,
/// which the policy never sees.
const SIGNED_FILE_PATH: &str = "/storage/v1/object/sign/";

/// A scheme no web page uses: the shell's own commands, reached by a navigation it intercepts (so pages
/// need no IPC). Only `alhc-shell://print` exists (WKWebView ignores `window.print()`).
pub const SHELL_SCHEME: &str = "alhc-shell";

/// The deep-link scheme (`tauri.conf.json` → plugins.deep-link; mapped by `@alhc/core/desktop-links`).
pub const LINK_SCHEME: &str = "alhc";

/// App pages that must run in the system browser: their email links (sign-up confirmation, password
/// reset) carry a PKCE code verifier that lives in the browser that asked, and the email opens in the
/// system browser. So people sign up and reset their password there, then sign in here.
const BROWSER_ONLY_PATHS: [&str; 2] = ["/signup", "/forgot-password"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowKind {
    /// The main window: the launcher, then the app.
    Main,
    /// A window a page opened (a file preview, a public form): app pages and stored files only.
    Popup,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    Allow,
    /// Cancel it here and hand the URL to the system (browser, mail app, calendar app).
    OpenExternally,
    /// Cancel it and print the page (`alhc-shell://print`).
    Print,
    /// Cancel it, nothing else.
    Ignore,
}

#[derive(Debug, PartialEq, Eq)]
pub enum NewWindow {
    /// Another app window, sharing the main window's session.
    InApp,
    OpenExternally,
    Ignore,
}

#[derive(Debug, Clone)]
pub struct Policy {
    app: Url,
    storage: Url,
    launchers: Vec<Url>,
}

/// Same scheme, host, and port. (`Url::origin` is opaque for custom schemes such as `tauri://`.)
fn same_site(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

fn is_local_host(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))
}

/// An origin a build may name: https, or http on this computer (a local web app or Supabase). Nothing
/// after the host.
fn origin_url(name: &str, value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|e| format!("{name} {value:?}: {e}"))?;
    let secure = url.scheme() == "https" || (url.scheme() == "http" && is_local_host(&url));
    let bare = url.path() == "/" && url.query().is_none() && url.fragment().is_none();
    if !secure || !bare || url.host_str().is_none() || !url.username().is_empty() {
        return Err(format!(
            "{name} {value:?} must be an https origin (or http://localhost), with nothing after the host"
        ));
    }
    Ok(url)
}

fn browser_only(path: &str) -> bool {
    BROWSER_ONLY_PATHS.iter().any(|p| {
        path == *p
            || path
                .strip_prefix(p)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// Links the system may open: web pages, email, calendar subscriptions, phone numbers.
pub fn opens_externally(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "http" | "mailto" | "webcal" | "tel")
}

impl Policy {
    /// `app_url`: the hosted app; `supabase_url`: its Supabase project (both origins: nothing after the
    /// host). `launchers`: where the launcher page is served (the app's own protocol, or the Vite dev
    /// server under `tauri dev`).
    pub fn new(app_url: &str, supabase_url: &str, launchers: &[Url]) -> Result<Self, String> {
        Ok(Self {
            app: origin_url("ALHC_APP_URL", app_url)?,
            storage: origin_url("ALHC_SUPABASE_URL", supabase_url)?,
            launchers: launchers.to_vec(),
        })
    }

    /// A signed file URL of the app's own Supabase project: shown in file previews and PDF frames. Not
    /// any Supabase project: another one's files would show in a window with no address bar.
    fn is_storage_file(&self, url: &Url) -> bool {
        same_site(url, &self.storage) && url.path().starts_with(SIGNED_FILE_PATH)
    }

    /// The app's origin as pages write it (`https://alhc-projects.vercel.app`, no slash).
    pub fn app_origin(&self) -> String {
        self.app.origin().ascii_serialization()
    }

    pub fn is_app(&self, url: &Url) -> bool {
        same_site(url, &self.app)
    }

    pub fn is_launcher(&self, url: &Url) -> bool {
        self.launchers.iter().any(|l| same_site(url, l))
    }

    /// A page of the app, as the path the launcher's `?to=` takes (path, query, and fragment).
    pub fn app_path(&self, url: &Url) -> Option<String> {
        if !self.is_app(url) {
            return None;
        }
        let mut path = url.path().to_string();
        if let Some(q) = url.query() {
            path.push('?');
            path.push_str(q);
        }
        if let Some(f) = url.fragment() {
            path.push('#');
            path.push_str(f);
        }
        Some(path)
    }

    /// Every navigation of a window's frames (WKWebView and WebKitGTK ask for iframes too).
    pub fn navigation(&self, url: &Url, kind: WindowKind) -> Navigation {
        match url.scheme() {
            // Empty frames (about:blank, about:srcdoc).
            "about" => return Navigation::Allow,
            SHELL_SCHEME => {
                return if url.host_str() == Some("print") {
                    Navigation::Print
                } else {
                    Navigation::Ignore
                };
            }
            _ => {}
        }
        if self.is_launcher(url) {
            return if kind == WindowKind::Main {
                Navigation::Allow
            } else {
                Navigation::Ignore
            };
        }
        if self.is_app(url) {
            return if browser_only(url.path()) {
                Navigation::OpenExternally
            } else {
                Navigation::Allow
            };
        }
        if self.is_storage_file(url) {
            return Navigation::Allow;
        }
        if opens_externally(url) {
            Navigation::OpenExternally
        } else {
            Navigation::Ignore
        }
    }

    /// A page asked for a new window (`target="_blank"`, ⌘-click, `window.open`).
    pub fn new_window(&self, url: &Url) -> NewWindow {
        if self.is_app(url) {
            return if browser_only(url.path()) {
                NewWindow::OpenExternally
            } else {
                NewWindow::InApp
            };
        }
        if self.is_storage_file(url) {
            return NewWindow::InApp;
        }
        if opens_externally(url) {
            NewWindow::OpenExternally
        } else {
            NewWindow::Ignore
        }
    }
}

/// How often pages may hand URLs to the system. Browsers only open other apps after a click; the shell
/// can't tell a click from a frame loading a link, so it limits instead: the same URL twice within two
/// seconds opens once (a frame reloading, a double click), and at most five URLs open in ten seconds.
#[derive(Debug, Default)]
pub struct ExternalGate {
    last: Option<(String, std::time::Instant)>,
    recent: std::collections::VecDeque<std::time::Instant>,
}

impl ExternalGate {
    const SAME_URL: std::time::Duration = std::time::Duration::from_secs(2);
    const WINDOW: std::time::Duration = std::time::Duration::from_secs(10);
    const MAX_IN_WINDOW: usize = 5;

    /// Whether `url` may open now (and, if so, counts it).
    pub fn allow(&mut self, url: &str, now: std::time::Instant) -> bool {
        if let Some((previous, at)) = &self.last {
            if previous == url && now.saturating_duration_since(*at) < Self::SAME_URL {
                return false;
            }
        }
        while self
            .recent
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= Self::WINDOW)
        {
            self.recent.pop_front();
        }
        if self.recent.len() >= Self::MAX_IN_WINDOW {
            return false;
        }
        self.recent.push_back(now);
        self.last = Some((url.to_string(), now));
        true
    }
}

/// The launcher page with one parameter: `open=<alhc:// link>` or `to=<app path>`.
pub fn launcher_url(base: &Url, key: &str, value: &str) -> Url {
    let mut url = base.join("index.html").unwrap_or_else(|_| base.clone());
    url.set_query(None);
    url.set_fragment(None);
    url.query_pairs_mut().append_pair(key, value);
    url
}

/// A deep link this app opens (`alhc:…`), from the OS or a second launch's arguments.
pub fn is_deep_link(url: &Url) -> bool {
    url.scheme() == LINK_SCHEME
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn policy() -> Policy {
        Policy::new(
            DEFAULT_APP_URL,
            DEFAULT_SUPABASE_URL,
            &[url("tauri://localhost"), url("http://tauri.localhost")],
        )
        .unwrap()
    }

    #[test]
    fn app_and_supabase_urls_must_be_https_origins() {
        let sb = DEFAULT_SUPABASE_URL;
        assert!(Policy::new("https://alhc-projects.vercel.app", sb, &[]).is_ok());
        assert!(Policy::new("https://alhc-projects.vercel.app/", sb, &[]).is_ok());
        assert!(Policy::new("http://localhost:3000", "http://127.0.0.1:54321", &[]).is_ok());
        for bad in [
            "http://alhc-projects.vercel.app",
            "https://alhc-projects.vercel.app/login",
            "https://alhc-projects.vercel.app/?x=1",
            "https://user@alhc-projects.vercel.app",
            "tauri://localhost",
            "file:///etc",
            "not a url",
        ] {
            assert!(Policy::new(bad, sb, &[]).is_err(), "{bad}");
            assert!(Policy::new(DEFAULT_APP_URL, bad, &[]).is_err(), "{bad}");
        }
        assert_eq!(policy().app_origin(), "https://alhc-projects.vercel.app");
    }

    #[test]
    fn main_window_shows_the_launcher_and_the_app() {
        let p = policy();
        for u in [
            "tauri://localhost/index.html?open=alhc%3A%2F%2Finbox",
            "http://tauri.localhost/index.html",
            "https://alhc-projects.vercel.app/",
            "https://alhc-projects.vercel.app/projects/x?task=y",
            "https://alhc-projects.vercel.app/login?next=%2Finbox",
            "https://alhc-projects.vercel.app/signups",
            "about:blank",
            "about:srcdoc",
        ] {
            assert_eq!(
                p.navigation(&url(u), WindowKind::Main),
                Navigation::Allow,
                "{u}"
            );
        }
    }

    #[test]
    fn sign_up_and_password_reset_run_in_the_browser() {
        let p = policy();
        for u in [
            "https://alhc-projects.vercel.app/signup",
            "https://alhc-projects.vercel.app/signup?email=a%40b.c&next=%2Fprojects%2Fx",
            "https://alhc-projects.vercel.app/forgot-password?expired=1",
        ] {
            assert_eq!(
                p.navigation(&url(u), WindowKind::Main),
                Navigation::OpenExternally,
                "{u}"
            );
            assert_eq!(p.new_window(&url(u)), NewWindow::OpenExternally, "{u}");
        }
    }

    #[test]
    fn stored_files_load_in_frames_and_previews() {
        let p = policy();
        let file = url("https://xsgmawawwstbrbukgsax.supabase.co/storage/v1/object/sign/task-attachments/t/a.pdf?token=x");
        assert_eq!(p.navigation(&file, WindowKind::Main), Navigation::Allow);
        assert_eq!(p.navigation(&file, WindowKind::Popup), Navigation::Allow);
        assert_eq!(p.new_window(&file), NewWindow::InApp);
        // Not a signed file of this project (public objects, another Supabase project, Supabase Auth, a
        // look-alike host): just another site.
        for u in [
            "https://xsgmawawwstbrbukgsax.supabase.co/storage/v1/object/public/avatars/x.png",
            "https://xsgmawawwstbrbukgsax.supabase.co/storage/v1/object/authenticated/b/x",
            "https://someoneelse.supabase.co/storage/v1/object/sign/b/fake-sign-in.svg?token=x",
            "https://xsgmawawwstbrbukgsax.supabase.co/auth/v1/authorize?provider=google",
            "https://supabase.co.evil.example/storage/v1/object/sign/x",
            "https://xsgmawawwstbrbukgsax.supabase.co.evil.example/storage/v1/object/sign/x",
            "http://xsgmawawwstbrbukgsax.supabase.co/storage/v1/object/sign/x",
        ] {
            assert_eq!(p.new_window(&url(u)), NewWindow::OpenExternally, "{u}");
            assert_eq!(
                p.navigation(&url(u), WindowKind::Main),
                Navigation::OpenExternally,
                "{u}"
            );
        }
    }

    #[test]
    fn other_sites_and_apps_open_outside() {
        let p = policy();
        for u in [
            "https://calendar.google.com/calendar/r?cid=webcal%3A%2F%2Fx",
            "https://app.asana.com/0/my-apps",
            "http://example.com/",
            "https://alhc-projects.vercel.app.evil.example/",
            "https://alhc-projects.vercel.app:8443/",
            "mailto:someone@example.com",
            "webcal://alhc-projects.vercel.app/api/calendar/x.ics",
            "tel:+15551234567",
        ] {
            assert_eq!(
                p.navigation(&url(u), WindowKind::Main),
                Navigation::OpenExternally,
                "{u}"
            );
            assert_eq!(p.new_window(&url(u)), NewWindow::OpenExternally, "{u}");
        }
    }

    #[test]
    fn nothing_else_loads() {
        let p = policy();
        for u in [
            "file:///etc/passwd",
            "data:text/html,hi",
            "javascript:alert(1)",
            "ftp://example.com/",
            "alhc://inbox",
            "smb://server/share",
        ] {
            assert_eq!(
                p.navigation(&url(u), WindowKind::Main),
                Navigation::Ignore,
                "{u}"
            );
            assert_eq!(p.new_window(&url(u)), NewWindow::Ignore, "{u}");
        }
        // Pop-ups never show the launcher.
        assert_eq!(
            p.navigation(&url("tauri://localhost/index.html"), WindowKind::Popup),
            Navigation::Ignore
        );
        assert_eq!(
            p.new_window(&url("tauri://localhost/index.html")),
            NewWindow::Ignore
        );
    }

    #[test]
    fn app_pages_open_in_app_windows() {
        let p = policy();
        for u in [
            "https://alhc-projects.vercel.app/attachments/x?preview=1",
            "https://alhc-projects.vercel.app/forms/f",
            "https://alhc-projects.vercel.app/approve/t",
        ] {
            assert_eq!(p.new_window(&url(u)), NewWindow::InApp, "{u}");
            assert_eq!(
                p.navigation(&url(u), WindowKind::Popup),
                Navigation::Allow,
                "{u}"
            );
        }
    }

    #[test]
    fn the_shell_prints_through_its_own_scheme() {
        let p = policy();
        assert_eq!(
            p.navigation(&url("alhc-shell://print"), WindowKind::Main),
            Navigation::Print
        );
        assert_eq!(
            p.navigation(&url("alhc-shell://print"), WindowKind::Popup),
            Navigation::Print
        );
        assert_eq!(
            p.navigation(&url("alhc-shell://other"), WindowKind::Main),
            Navigation::Ignore
        );
        assert_eq!(p.new_window(&url("alhc-shell://print")), NewWindow::Ignore);
    }

    #[test]
    fn app_paths_and_launcher_urls() {
        let p = policy();
        assert_eq!(
            p.app_path(&url(
                "https://alhc-projects.vercel.app/projects/x/views/y?task=t#c"
            ))
            .as_deref(),
            Some("/projects/x/views/y?task=t#c")
        );
        assert_eq!(p.app_path(&url("https://example.com/")), None);
        assert_eq!(p.app_path(&url("tauri://localhost/index.html")), None);

        let base = url("tauri://localhost");
        assert_eq!(
            launcher_url(&base, "open", "alhc://projects/x?task=y").as_str(),
            "tauri://localhost/index.html?open=alhc%3A%2F%2Fprojects%2Fx%3Ftask%3Dy"
        );
        assert_eq!(
            launcher_url(&url("http://localhost:1420/"), "to", "/inbox?tab=archive").as_str(),
            "http://localhost:1420/index.html?to=%2Finbox%3Ftab%3Darchive"
        );
        assert!(p.is_launcher(&url("http://tauri.localhost/index.html?to=%2F")));
        assert!(!p.is_launcher(&url("http://tauri.localhost.evil.example/")));
    }

    #[test]
    fn external_opens_are_limited() {
        use std::time::{Duration, Instant};
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut gate = ExternalGate::default();
        assert!(gate.allow("https://a.example/", at(0)));
        assert!(
            !gate.allow("https://a.example/", at(1_000)),
            "the same URL within 2 s"
        );
        assert!(gate.allow("https://a.example/", at(2_500)));
        for (i, ms) in [3_000, 3_100, 3_200].iter().enumerate() {
            assert!(gate.allow(&format!("https://b{i}.example/"), at(*ms)));
        }
        assert!(
            !gate.allow("https://c.example/", at(4_000)),
            "a sixth URL within 10 s"
        );
        assert!(
            gate.allow("https://c.example/", at(10_100)),
            "the first one left the window"
        );
    }

    #[test]
    fn deep_links() {
        assert!(is_deep_link(&url("alhc://projects/x")));
        assert!(is_deep_link(&url("ALHC://projects/x")));
        assert!(!is_deep_link(&url("https://alhc-projects.vercel.app/")));
    }
}
