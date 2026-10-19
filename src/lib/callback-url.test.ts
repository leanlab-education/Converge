import { describe, expect, it } from 'vitest'
import { DEFAULT_POST_LOGIN_PATH, resolveCallbackUrl } from './callback-url'

const ORIGIN = 'https://writing-evaluator.vercel.app'

describe('resolveCallbackUrl', () => {
  it('falls back to the home page when nothing was requested', () => {
    expect(resolveCallbackUrl(null)).toBe(DEFAULT_POST_LOGIN_PATH)
    expect(resolveCallbackUrl(undefined)).toBe('/')
    expect(resolveCallbackUrl('')).toBe('/')
  })

  it('honors a relative path, including its query string', () => {
    expect(resolveCallbackUrl('/adjudicate')).toBe('/adjudicate')
    expect(resolveCallbackUrl('/admin/p1?tab=batches')).toBe('/admin/p1?tab=batches')
  })

  it('rejects protocol-relative paths that browsers treat as another host', () => {
    expect(resolveCallbackUrl('//evil.com/phish')).toBe('/')
    expect(resolveCallbackUrl('/\\evil.com/phish')).toBe('/')
  })

  it('reduces an absolute URL on our own origin to its path (what Auth.js sends)', () => {
    expect(resolveCallbackUrl(`${ORIGIN}/adjudicate?x=1#top`, ORIGIN)).toBe(
      '/adjudicate?x=1#top'
    )
  })

  it('rejects an absolute URL on another origin', () => {
    expect(resolveCallbackUrl('https://evil.com/adjudicate', ORIGIN)).toBe('/')
    // Same host, different scheme is still another origin.
    expect(resolveCallbackUrl('http://writing-evaluator.vercel.app/adjudicate', ORIGIN)).toBe('/')
  })

  it('rejects an absolute URL when no origin is known to compare against', () => {
    expect(resolveCallbackUrl(`${ORIGIN}/adjudicate`)).toBe('/')
  })

  it('rejects non-URL schemes and garbage', () => {
    expect(resolveCallbackUrl('javascript:alert(1)', ORIGIN)).toBe('/')
    expect(resolveCallbackUrl('not a url', ORIGIN)).toBe('/')
    expect(resolveCallbackUrl('adjudicate')).toBe('/')
  })

  it('never redirects back onto the login page', () => {
    expect(resolveCallbackUrl('/login')).toBe('/')
    expect(resolveCallbackUrl('/login?callbackUrl=/adjudicate')).toBe('/')
    expect(resolveCallbackUrl(`${ORIGIN}/login`, ORIGIN)).toBe('/')
    // A path that merely starts with the letters is fine.
    expect(resolveCallbackUrl('/login-help')).toBe('/login-help')
  })
})
