/**
 * Production guard for scripts that write to the database.
 *
 * Every Doppler config of this project (dev / stg / prd) points at the single
 * production Neon database, and `doppler run -c dev` sets neither NODE_ENV
 * nor VERCEL — so the old `NODE_ENV === 'production'` checks never fired, and
 * the seed accounts ended up in production that way. This guard looks at the
 * one thing that is actually true about the target: the host in DATABASE_URL.
 *
 *   - local hosts (localhost, docker service names, ...) → run silently
 *   - the known production host → refuse, unless `--allow-prod` is passed AND
 *     the operator types the host name back at an interactive prompt
 *   - any other *.neon.tech host (a preview branch) → same as production;
 *     a branch is one copy-paste away from the real thing
 *   - `neverProduction` scripts (test-data generators) → refuse the known
 *     production host even with `--allow-prod`
 *
 * Usage, at the top of main() or right before the first write:
 *
 *   await assertNotProduction('my-script')
 *   await assertNotProduction('seed', { neverProduction: true })
 *
 * The decision itself is a pure function (decideProductionGuard) and is unit
 * tested in test/scripts-guard.test.ts.
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

export const PRODUCTION_HOST_MARKER = 'ep-dark-moon-aedx88jy'
export const HOSTED_HOST_MARKER = 'neon.tech'
export const ALLOW_PROD_FLAG = '--allow-prod'

export interface GuardOptions {
  // The operator passed --allow-prod (or the script decided to treat it so).
  allowProd: boolean
  // Refuse the known production host no matter what. For scripts whose only
  // purpose is test data.
  neverProduction?: boolean
}

export type GuardDecision =
  | { kind: 'allow'; host: string }
  | { kind: 'confirm'; host: string; reason: string }
  | { kind: 'refuse'; host: string | null; reason: string }

function refuse(host: string | null, reason: string): GuardDecision {
  return { kind: 'refuse', host, reason }
}

export function hostOf(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null
  try {
    const host = new URL(databaseUrl).hostname.trim().toLowerCase()
    return host.length > 0 ? host : null
  } catch {
    return null
  }
}

export function decideProductionGuard(
  databaseUrl: string | undefined,
  options: GuardOptions
): GuardDecision {
  if (!databaseUrl) return refuse(null, 'DATABASE_URL is not set.')
  const host = hostOf(databaseUrl)
  if (!host) return refuse(null, 'DATABASE_URL is not a URL with a host; refusing to guess.')

  const isKnownProduction = host.includes(PRODUCTION_HOST_MARKER)
  const isHosted = host.includes(HOSTED_HOST_MARKER)
  if (!isKnownProduction && !isHosted) return { kind: 'allow', host }

  const what = isKnownProduction
    ? 'the PRODUCTION database'
    : 'a hosted Neon database (every Doppler config of this project points at production)'

  if (isKnownProduction && options.neverProduction) {
    return refuse(
      host,
      `${host} is ${what}, and this script only generates test data. It never runs there, with or without ${ALLOW_PROD_FLAG}.`
    )
  }
  if (!options.allowProd) {
    return refuse(
      host,
      `${host} is ${what}. Refusing to write. If you really mean it, pass ${ALLOW_PROD_FLAG}; you will be asked to type the host name back.`
    )
  }
  return { kind: 'confirm', host, reason: `${host} is ${what}.` }
}

export function confirmsHost(answer: string, host: string): boolean {
  return answer.trim().toLowerCase() === host.toLowerCase()
}

export function hasAllowProdFlag(argv: string[] = process.argv): boolean {
  return argv.includes(ALLOW_PROD_FLAG)
}

// Positional arguments with every `--flag` / `--flag=value` removed, so
// `--allow-prod` and `--write` can appear anywhere on the command line.
export function positionalArgs(argv: string[] = process.argv): string[] {
  return argv.slice(2).filter((arg) => !arg.startsWith('--'))
}

export async function assertNotProduction(
  scriptName: string,
  options: { allowProd?: boolean; neverProduction?: boolean } = {}
): Promise<void> {
  const allowProd = options.allowProd ?? hasAllowProdFlag()
  const decision = decideProductionGuard(process.env.DATABASE_URL, {
    allowProd,
    neverProduction: options.neverProduction,
  })
  console.log(`[${scriptName}] database host: ${decision.host ?? '(none)'}`)

  if (decision.kind === 'allow') return
  if (decision.kind === 'refuse') {
    console.error(`[${scriptName}] ${decision.reason}`)
    process.exit(1)
  }

  if (!stdin.isTTY) {
    console.error(
      `[${scriptName}] ${decision.reason} ${ALLOW_PROD_FLAG} needs an interactive terminal to confirm the host; refusing.`
    )
    process.exit(1)
  }
  const rl = createInterface({ input: stdin, output: stdout })
  let answer: string
  try {
    answer = await rl.question(
      `[${scriptName}] ${decision.reason}\nType the host name exactly to proceed (anything else aborts): `
    )
  } finally {
    rl.close()
  }
  if (!confirmsHost(answer, decision.host)) {
    console.error(`[${scriptName}] Host name did not match. Aborting; nothing was written.`)
    process.exit(1)
  }
  console.log(`[${scriptName}] Host confirmed. Proceeding against ${decision.host}.`)
}
