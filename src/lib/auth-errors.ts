// Sign-in error classification shared between the Auth.js authorize()
// callback (server) and the login page (client). No server imports — safe to
// import from client components.
//
// Why this exists: on 2026-09-27 the Neon database hit its plan quota and every
// query failed, but the login page reported "Invalid email or password" and the
// reset page reported "Check your email" — so annotators assumed their
// credentials were wrong. An infrastructure failure must never look like a
// user error.

// Auth.js forwards the `code` of a thrown CredentialsSignin subclass to the
// client as `result.code` on signIn({ redirect: false }).
export const SERVICE_UNAVAILABLE_CODE = 'service_unavailable'

export type SignInFailure = 'credentials' | 'unavailable'

type SignInResult = { error?: string | null; code?: string | null } | undefined

// Classifies a signIn() result; null on success. Only a genuine
// CredentialsSignin (bad password / bad or expired link) is the user's fault;
// anything else — our explicit service_unavailable code, or an unexpected
// Auth.js error such as "Configuration" — is ours.
export function classifySignInFailure(result: SignInResult): SignInFailure | null {
  if (!result?.error) return null
  if (result.code === SERVICE_UNAVAILABLE_CODE) return 'unavailable'
  if (result.error === 'CredentialsSignin') return 'credentials'
  return 'unavailable'
}

export const PASSWORD_SIGN_IN_MESSAGES: Record<SignInFailure, string> = {
  credentials: 'Invalid email or password',
  unavailable:
    'Sign-in is temporarily unavailable. Please try again in a few minutes. If this keeps happening, contact your study coordinator.',
}

// StudyFlow-launched annotators have no password here — their account lives in
// StudyFlow — so their failure copy must never point at the password form or
// reset flow. The fix is always "reopen the activity in StudyFlow", which mints
// a fresh link.
export const STUDYFLOW_SIGN_IN_MESSAGES: Record<SignInFailure, string> = {
  credentials:
    'Your sign-in link from StudyFlow has expired or is no longer valid. Please go back to StudyFlow and open the scoring activity again.',
  unavailable:
    'Sign-in is temporarily unavailable. Please try again in a few minutes by opening the scoring activity in StudyFlow again. If this keeps happening, contact your study coordinator.',
}

export function isSignInFailure(value: string | null): value is SignInFailure {
  return value === 'credentials' || value === 'unavailable'
}

export const RESET_UNAVAILABLE_MESSAGE =
  'We couldn’t send a reset link right now. Please try again in a few minutes. If this keeps happening, contact your study coordinator.'
