// The shell's Invite (sidebar, Create menu, avatar menu) for people who aren't workspace admins opens the
// current project's Share (Nov 10 audit, C13): a cancelable window event the project page
// (ProjectPageProvider) answers with preventDefault(), so the shell knows whether a project heard it.
export const OPEN_SHARE_EVENT = "alhc:open-share";

// True when a project page opened its Share dialog.
export function requestOpenShare(): boolean {
  return !window.dispatchEvent(new Event(OPEN_SHARE_EVENT, { cancelable: true }));
}
