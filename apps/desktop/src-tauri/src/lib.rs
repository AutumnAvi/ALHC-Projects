//! ALHC Projects for Mac and Windows (big move 3, docs/design/desktop.md): a Tauri shell around the hosted
//! web app. Online-only. The shell's whole job: open the hosted app in a window, keep it to the app's own
//! pages (policy.rs), open links and downloads the way a desktop app should (shell.rs), take alhc:// links,
//! and give macOS its menus (menu.rs). Pages get no Tauri IPC.

// The app menu: macOS (and Linux development builds); Windows has none.
#[cfg(not(windows))]
mod menu;
mod policy;
mod shell;

use tauri::{Manager, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

pub fn run() {
    let app = tauri::Builder::default()
        // First, so a second launch (Windows and Linux hand a deep link to a new process) only wakes this
        // one; with the deep-link feature it also passes the link on to on_open_url below.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = shell::main_window(app) {
                shell::show(&window);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        // Without its link script: by default the opener plugin adds a click handler to every page that
        // cancels target="_blank" and Ctrl / Shift clicks and asks for `open_url` over IPC, which pages don't
        // get (no capabilities), so those links would do nothing. The webview asks the shell for the new
        // window instead (shell.rs → on_new_window), and the shell opens other sites from Rust.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(|label| label == shell::MAIN)
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(shell::Shell::new(&handle)?);

            // An installed app has its scheme registered by its installer (macOS: Info.plist). A
            // development build registers it only when asked (ALHC_DESKTOP_REGISTER_SCHEME=1): the
            // registration stays after it exits and points alhc:// links at target/debug, the installed
            // app's own included (Windows installs per user, under the same key), until it's reinstalled.
            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            if std::env::var_os("ALHC_DESKTOP_REGISTER_SCHEME").is_some() {
                app.deep_link().register_all()?;
            }

            let opened_with = app
                .deep_link()
                .get_current()
                .ok()
                .flatten()
                .unwrap_or_default();
            let link = opened_with.iter().find(|url| policy::is_deep_link(url));
            shell::open_main(&handle, link)?;

            let links = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls().iter().filter(|url| policy::is_deep_link(url)) {
                    shell::open_link(&links, url);
                }
            });

            #[cfg(not(windows))]
            {
                app.set_menu(menu::build(&handle)?)?;
                app.on_menu_event(menu::handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            if let WindowEvent::Destroyed = event {
                shell::forget_window(app, window.label());
                return;
            }
            let Some(webview) = app.get_webview_window(window.label()) else {
                return;
            };
            match event {
                WindowEvent::Focused(focused) => shell::focus_changed(app, &webview, *focused),
                // macOS: closing the window keeps the app running (⌘Q quits); the Dock icon brings it back.
                // A window in full screen leaves it first (hiding it there would leave an empty Space):
                // it's hidden once the exit is done (tao reports the resize then).
                #[cfg(target_os = "macos")]
                WindowEvent::CloseRequested { api, .. } if window.label() == shell::MAIN => {
                    api.prevent_close();
                    shell::hide_main(app, &webview);
                }
                #[cfg(target_os = "macos")]
                WindowEvent::Resized(_) if window.label() == shell::MAIN => {
                    shell::resized_main(app, &webview);
                }
                // Windows and Linux: closing the main window quits, its other windows too.
                #[cfg(not(target_os = "macos"))]
                WindowEvent::CloseRequested { .. } if window.label() == shell::MAIN => app.exit(0),
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("couldn't start ALHC Projects");

    app.run(|_app, _event| {
        // macOS: a click on the Dock icon brings the (hidden) window back.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            match shell::main_window(_app) {
                Some(window) => shell::show(&window),
                None => {
                    let _ = shell::open_main(_app, None);
                }
            }
        }
    });
}
