import { describe, expect, it } from 'vitest'
import {
  SERVICE_UNAVAILABLE_CODE,
  STUDYFLOW_SIGN_IN_MESSAGES,
  classifySignInFailure,
  isSignInFailure,
} from './auth-errors'

describe('classifySignInFailure', () => {
  it('returns null on success', () => {
    expect(classifySignInFailure({ error: null })).toBeNull()
    expect(classifySignInFailure(undefined)).toBeNull()
  })

  it('blames the credentials only for a plain CredentialsSignin', () => {
    expect(classifySignInFailure({ error: 'CredentialsSignin', code: 'credentials' })).toBe(
      'credentials'
    )
  })

  it('reports an outage when the server flags service_unavailable', () => {
    expect(
      classifySignInFailure({ error: 'CredentialsSignin', code: SERVICE_UNAVAILABLE_CODE })
    ).toBe('unavailable')
  })

  it('reports an outage for any other Auth.js error (never blames the user)', () => {
    expect(classifySignInFailure({ error: 'Configuration' })).toBe('unavailable')
  })
})

describe('isSignInFailure', () => {
  it('accepts only known failure kinds from the URL', () => {
    expect(isSignInFailure('credentials')).toBe(true)
    expect(isSignInFailure('unavailable')).toBe(true)
    expect(isSignInFailure(null)).toBe(false)
    expect(isSignInFailure('<script>')).toBe(false)
  })
})

describe('STUDYFLOW_SIGN_IN_MESSAGES', () => {
  // StudyFlow annotators have no password in this app; their failure copy must
  // never send them to the password form or reset flow.
  it('never mentions passwords', () => {
    for (const message of Object.values(STUDYFLOW_SIGN_IN_MESSAGES)) {
      expect(message.toLowerCase()).not.toContain('password')
      expect(message).toContain('StudyFlow')
    }
  })
})
