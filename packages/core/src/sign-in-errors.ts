// The sign-in screen's error box (Nov 10 audit, C88): /login?error=<code> shows one of these fixed
// messages, never text from the link itself (a crafted link could otherwise put any red message on the
// real sign-in page). The auth callback sends a code; anything else reads as the generic one.

export const SIGN_IN_ERRORS = {
  interrupted: "Sign-in was interrupted. Please try again.",
  provider: "The sign-in provider couldn’t sign you in. Please try again.",
  failed: "Could not complete sign-in. The link may have expired or been used already; please try again.",
} as const;
export type SignInErrorCode = keyof typeof SIGN_IN_ERRORS;

export function signInErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(SIGN_IN_ERRORS, code) ? SIGN_IN_ERRORS[code as SignInErrorCode] : SIGN_IN_ERRORS.failed;
}
