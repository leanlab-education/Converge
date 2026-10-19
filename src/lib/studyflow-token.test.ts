import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SignJWT, type JWTPayload } from 'jose'
import {
  STUDYFLOW_TOKEN_AUDIENCE,
  STUDYFLOW_TOKEN_ISSUER,
  verifyStudyFlowToken,
} from './studyflow-token'

const SECRET = 'unit-test-studyflow-secret'

type SignOptions = {
  secret?: string
  issuer?: string | null
  audience?: string | null
  expiresIn?: string | null
  issuedAt?: number
}

// Mirrors what StudyFlow's generateWritingEvaluatorLink() produces, with each
// claim overridable so a test can break exactly one thing.
async function sign(claims: JWTPayload, opts: SignOptions = {}) {
  let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' })
  jwt = opts.issuedAt === undefined ? jwt.setIssuedAt() : jwt.setIssuedAt(opts.issuedAt)
  if (opts.issuer !== null) jwt = jwt.setIssuer(opts.issuer ?? STUDYFLOW_TOKEN_ISSUER)
  if (opts.audience !== null) jwt = jwt.setAudience(opts.audience ?? STUDYFLOW_TOKEN_AUDIENCE)
  if (opts.expiresIn !== null) jwt = jwt.setExpirationTime(opts.expiresIn ?? '5m')
  return jwt.sign(new TextEncoder().encode(opts.secret ?? SECRET))
}

beforeEach(() => {
  vi.stubEnv('STUDYFLOW_LINK_SECRET', SECRET)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('verifyStudyFlowToken', () => {
  it('accepts a mixed-case email claim against the lowercased login param', async () => {
    const token = await sign({
      email: 'Jane.Doe@Example.com',
      name: 'Jane Doe',
      project_id: 'p1',
    })

    await expect(verifyStudyFlowToken(token, 'jane.doe@example.com')).resolves.toEqual({
      email: 'jane.doe@example.com',
      name: 'Jane Doe',
      projectId: 'p1',
      studyId: undefined,
    })
  })

  it('normalizes whitespace and case on both sides', async () => {
    const token = await sign({ email: ' JANE@example.com' })
    const verified = await verifyStudyFlowToken(token, 'Jane@Example.COM ')
    expect(verified?.email).toBe('jane@example.com')
  })

  it('rejects a token issued for a different address', async () => {
    const token = await sign({ email: 'jane@example.com' })
    await expect(verifyStudyFlowToken(token, 'mallory@example.com')).resolves.toBeNull()
  })

  it('rejects a non-string email claim', async () => {
    const token = await sign({ email: ['jane@example.com'] })
    await expect(verifyStudyFlowToken(token, 'jane@example.com')).resolves.toBeNull()
  })

  it('rejects a token with no expiration', async () => {
    const token = await sign({ email: 'jane@example.com' }, { expiresIn: null })
    await expect(verifyStudyFlowToken(token, 'jane@example.com')).resolves.toBeNull()
  })

  it('rejects a token older than the max age even if exp is far out', async () => {
    const elevenMinutesAgo = Math.floor(Date.now() / 1000) - 11 * 60
    const token = await sign(
      { email: 'jane@example.com' },
      { issuedAt: elevenMinutesAgo, expiresIn: '2h' }
    )
    await expect(verifyStudyFlowToken(token, 'jane@example.com')).resolves.toBeNull()
  })

  it('rejects the wrong issuer, audience or secret', async () => {
    const email = 'jane@example.com'
    await expect(
      verifyStudyFlowToken(await sign({ email }, { issuer: 'someone-else' }), email)
    ).resolves.toBeNull()
    await expect(
      verifyStudyFlowToken(await sign({ email }, { audience: 'another-app' }), email)
    ).resolves.toBeNull()
    await expect(
      verifyStudyFlowToken(await sign({ email }, { secret: 'wrong-secret' }), email)
    ).resolves.toBeNull()
  })

  it('rejects everything when no secret is configured', async () => {
    const token = await sign({ email: 'jane@example.com' })
    vi.stubEnv('STUDYFLOW_LINK_SECRET', '')
    await expect(verifyStudyFlowToken(token, 'jane@example.com')).resolves.toBeNull()
  })

  it('returns null rather than throwing on a malformed token', async () => {
    await expect(verifyStudyFlowToken('not-a-jwt', 'jane@example.com')).resolves.toBeNull()
  })
})
