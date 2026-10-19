import { describe, it, expect } from 'vitest'
import {
  ALLOW_PROD_FLAG,
  PRODUCTION_HOST_MARKER,
  confirmsHost,
  decideProductionGuard,
  hasAllowProdFlag,
  hostOf,
  positionalArgs,
} from '../scripts/_guard'

const PROD_URL =
  'postgresql://neondb_owner:secret@ep-dark-moon-aedx88jy.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require'
const BRANCH_URL =
  'postgresql://neondb_owner:secret@ep-quiet-river-123456.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require'
const LOCAL_URL = 'postgresql://converge:converge@localhost:5432/converge_dev'
const DOCKER_URL = 'postgres://u:p@db:5432/x'

describe('hostOf', () => {
  it('extracts and lowercases the host', () => {
    expect(hostOf(PROD_URL)).toBe('ep-dark-moon-aedx88jy.c-2.us-east-2.aws.neon.tech')
    expect(hostOf('postgresql://u:p@LOCALHOST:5432/x')).toBe('localhost')
  })

  it('returns null for missing, empty or unparseable values', () => {
    expect(hostOf(undefined)).toBeNull()
    expect(hostOf('')).toBeNull()
    expect(hostOf('not a url')).toBeNull()
    expect(hostOf('postgresql:///nohost')).toBeNull()
  })
})

describe('decideProductionGuard', () => {
  it('refuses when DATABASE_URL is unset or unparseable (fail closed)', () => {
    expect(decideProductionGuard(undefined, { allowProd: true })).toMatchObject({
      kind: 'refuse',
      host: null,
    })
    expect(decideProductionGuard('garbage', { allowProd: true })).toMatchObject({
      kind: 'refuse',
      host: null,
    })
  })

  it('allows local hosts without ceremony', () => {
    expect(decideProductionGuard(LOCAL_URL, { allowProd: false })).toEqual({
      kind: 'allow',
      host: 'localhost',
    })
    expect(decideProductionGuard(DOCKER_URL, { allowProd: false })).toEqual({
      kind: 'allow',
      host: 'db',
    })
  })

  it('refuses the known production host without --allow-prod', () => {
    const decision = decideProductionGuard(PROD_URL, { allowProd: false })
    expect(decision.kind).toBe('refuse')
    expect(decision.host).toContain(PRODUCTION_HOST_MARKER)
    expect(decision.kind === 'refuse' && decision.reason).toContain(ALLOW_PROD_FLAG)
    expect(decision.kind === 'refuse' && decision.reason).toContain('PRODUCTION')
  })

  it('requires typed confirmation for the production host with --allow-prod', () => {
    const decision = decideProductionGuard(PROD_URL, { allowProd: true })
    expect(decision).toMatchObject({
      kind: 'confirm',
      host: 'ep-dark-moon-aedx88jy.c-2.us-east-2.aws.neon.tech',
    })
  })

  it('never lets a test-data script touch production, even with --allow-prod', () => {
    const decision = decideProductionGuard(PROD_URL, {
      allowProd: true,
      neverProduction: true,
    })
    expect(decision.kind).toBe('refuse')
    expect(decision.kind === 'refuse' && decision.reason).toMatch(/test data/)
  })

  it('treats every other neon.tech host like production (branches are one paste away)', () => {
    expect(decideProductionGuard(BRANCH_URL, { allowProd: false }).kind).toBe('refuse')
    expect(decideProductionGuard(BRANCH_URL, { allowProd: true })).toMatchObject({
      kind: 'confirm',
      host: 'ep-quiet-river-123456.c-2.us-east-2.aws.neon.tech',
    })
  })

  it('lets a test-data script run on a Neon branch after confirmation', () => {
    expect(
      decideProductionGuard(BRANCH_URL, { allowProd: true, neverProduction: true }).kind
    ).toBe('confirm')
  })

  it('matches the production marker regardless of case', () => {
    const upper = PROD_URL.replace('ep-dark-moon-aedx88jy', 'EP-DARK-MOON-AEDX88JY')
    expect(decideProductionGuard(upper, { allowProd: false }).kind).toBe('refuse')
  })
})

describe('confirmsHost', () => {
  const host = 'ep-dark-moon-aedx88jy.c-2.us-east-2.aws.neon.tech'

  it('accepts the exact host, ignoring surrounding whitespace and case', () => {
    expect(confirmsHost(host, host)).toBe(true)
    expect(confirmsHost(`  ${host}\n`, host)).toBe(true)
    expect(confirmsHost(host.toUpperCase(), host)).toBe(true)
  })

  it('rejects anything else, including "yes" and a partial host', () => {
    expect(confirmsHost('yes', host)).toBe(false)
    expect(confirmsHost('y', host)).toBe(false)
    expect(confirmsHost('ep-dark-moon-aedx88jy', host)).toBe(false)
    expect(confirmsHost('', host)).toBe(false)
  })
})

describe('argv helpers', () => {
  const argv = ['node', 'script.ts', 'Project Name', '--write', '/tmp/x.csv', '--allow-prod', '--k=v']

  it('positionalArgs drops every --flag so flags may appear anywhere', () => {
    expect(positionalArgs(argv)).toEqual(['Project Name', '/tmp/x.csv'])
    expect(positionalArgs(['node', 'script.ts'])).toEqual([])
  })

  it('hasAllowProdFlag detects the exact flag only', () => {
    expect(hasAllowProdFlag(argv)).toBe(true)
    expect(hasAllowProdFlag(['node', 'script.ts', '--allow-production'])).toBe(false)
    expect(hasAllowProdFlag(['node', 'script.ts'])).toBe(false)
  })
})
