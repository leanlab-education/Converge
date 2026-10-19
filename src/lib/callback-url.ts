// Where to send someone after they sign in.
//
// Auth.js bounces an unauthenticated request to
// `/login?callbackUrl=<absolute href of the page they tried to open>`, and our
// own pages pass relative ones (adjudicate/page.tsx). The value arrives in the
// URL, so it is attacker-controlled: an open redirect to another origin must
// never be honored. Exactly two shapes are accepted, a relative path or an
// absolute URL on `origin` (reduced to its path); anything else falls back to
// the home page, which itself routes each role to the right dashboard.

export const DEFAULT_POST_LOGIN_PATH = '/'

export function resolveCallbackUrl(
  raw: string | null | undefined,
  origin?: string
): string {
  if (!raw) return DEFAULT_POST_LOGIN_PATH

  let path: string
  if (raw.startsWith('/')) {
    // "//evil.com" and "/\evil.com" are protocol-relative to browsers.
    if (raw.startsWith('//') || raw.startsWith('/\\')) return DEFAULT_POST_LOGIN_PATH
    path = raw
  } else if (origin) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return DEFAULT_POST_LOGIN_PATH
    }
    if (url.origin !== origin) return DEFAULT_POST_LOGIN_PATH
    path = `${url.pathname}${url.search}${url.hash}`
  } else {
    return DEFAULT_POST_LOGIN_PATH
  }

  // Never bounce back onto the login page itself: /login?callbackUrl=/login
  // would loop for a signed-in visitor.
  if (path === '/login' || path.startsWith('/login?') || path.startsWith('/login/')) {
    return DEFAULT_POST_LOGIN_PATH
  }

  return path
}
