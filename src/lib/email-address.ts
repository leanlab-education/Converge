// Email normalization shared by every place an address enters the system:
// sign-in, invites, account creation, StudyFlow import and magic links.
//
// `User.email` is unique and stored lowercased, so a lookup with a
// differently-cased address misses. Every writer and every reader must go
// through the same normalization: an account created as "Jane@Example.com"
// could otherwise never sign in or reset its password, because those paths
// lowercase before looking it up.

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

// Deliberately loose: one "@" with something on both sides and a dot in the
// domain. The goal is to catch missing or garbage values (an empty string, a
// name typed into the email box), not to validate RFC 5322.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(email: string): boolean {
  return EMAIL_SHAPE.test(email)
}

// Turns an untrusted value (request body, upstream API payload) into a
// storable address, or null when it is missing or not email-shaped.
export function parseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = normalizeEmail(raw)
  return isValidEmail(email) ? email : null
}
