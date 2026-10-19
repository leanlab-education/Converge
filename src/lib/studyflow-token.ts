import { jwtVerify } from 'jose'
import { normalizeEmail } from './email-address'

// Verification of the signed magic-link token StudyFlow mints in
// `generateWritingEvaluatorLink()`. The issuer/audience/secret are a
// cross-repo contract; see CLAUDE.md "StudyFlow Integration".
export const STUDYFLOW_TOKEN_ISSUER = 'studyflow'
export const STUDYFLOW_TOKEN_AUDIENCE = 'writing-evaluator'
// Reject tokens older than this even if their exp is far out.
export const STUDYFLOW_TOKEN_MAX_AGE = '10m'

export type VerifiedStudyFlowLink = {
  // Normalized (trimmed, lowercased) — safe to use for the User lookup.
  email: string
  name: string | undefined
  projectId: string | undefined
  studyId: string | undefined
}

// Returns the link's claims when the token is valid and was issued for
// `email`, otherwise null. The comparison is case-insensitive on both sides:
// StudyFlow sends the address as the user typed it there, while the login
// page lowercases the query param before it gets here, so a mixed-case
// account would otherwise fail with "link expired" on every launch.
export async function verifyStudyFlowToken(
  token: string,
  email: string
): Promise<VerifiedStudyFlowLink | null> {
  const secret = process.env.STUDYFLOW_LINK_SECRET
  if (!secret) return null

  try {
    const key = new TextEncoder().encode(secret)
    const { payload } = await jwtVerify(token, key, {
      maxTokenAge: STUDYFLOW_TOKEN_MAX_AGE,
      issuer: STUDYFLOW_TOKEN_ISSUER,
      audience: STUDYFLOW_TOKEN_AUDIENCE,
    })

    // Require an expiration claim — reject tokens without one.
    if (!payload.exp) return null

    if (typeof payload.email !== 'string') return null
    const claimedEmail = normalizeEmail(payload.email)
    if (claimedEmail !== normalizeEmail(email)) return null

    return {
      email: claimedEmail,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      projectId: typeof payload.project_id === 'string' ? payload.project_id : undefined,
      studyId: typeof payload.study_id === 'string' ? payload.study_id : undefined,
    }
  } catch {
    return null
  }
}
