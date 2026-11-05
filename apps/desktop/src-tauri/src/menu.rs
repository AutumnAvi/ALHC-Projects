//! The app menu (macOS and Linux; Windows has none: WebView2's own keys reload (Ctrl+R, F5), go back and
//! forward (Alt+←/→), print (Ctrl+P), and find (Ctrl+F)). On macOS the Edit menu is what makes ⌘C, ⌘V,
//! ⌘X, and ⌘A work in the page at all.

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, WebviewWindow, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::shell;

const RELOAD: &str = "reload";
const BACK: &str = "back";
const FORWARD: &str = "forward";
const PRINT: &str = "print";
const OPEN_IN_BROWSER: &str = "open-in-browser";

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let about = AboutMetadata {
        name: Some("ALHC Projects".into()),
        version: Some(app.package_info().version.to_string()),
        copyright: Some("Autumn Lake".into()),
        ..Default::default()
    };
    let app_menu = SubmenuBuilder::new(app, "ALHC Projects")
        .about(Some(about))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id(OPEN_IN_BROWSER, "Open in Browser")
                .accelerator("CmdOrCtrl+Shift+O")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id(PRINT, "Print…")
                .accelerator("CmdOrCtrl+P")
                .build(app)?,
        )
        .separator()
        .close_window()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id(RELOAD, "Reload")
                .accelerator("CmdOrCtrl+R")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id(BACK, "Back")
                .accelerator("CmdOrCtrl+[")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(FORWARD, "Forward")
                .accelerator("CmdOrCtrl+]")
                .build(app)?,
        )
        .separator()
        .fullscreen()
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &window])
        .build()
}

/// The window a menu command is for: the focused one, else the main window.
fn target(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| shell::main_window(app))
}

pub fn handle(app: &AppHandle, event: MenuEvent) {
    let Some(window) = target(app) else { return };
    match event.id().as_ref() {
        RELOAD => shell::reload(app, &window),
        BACK => {
            let _ = window.eval("history.back()");
        }
        FORWARD => {
            let _ = window.eval("history.forward()");
        }
        PRINT => {
            let _ = window.print();
        }
        OPEN_IN_BROWSER => {
            if let Some(url) = shell::app_url(app, &window) {
                let _ = app.opener().open_url(url.as_str(), None::<&str>);
            }
        }
        _ => {}
    }
}
