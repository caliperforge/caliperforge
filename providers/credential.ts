import { readFileSync } from 'node:fs'

/** What the SDK subprocess will authenticate with, named without its value. */
export interface Auth {
  kind: 'oauth' | 'api-key' | 'none'
  from: string
}

const KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const

type Env = Record<string, string | undefined>

/**
 * `query()` hands the SDK subprocess this process's environment and nothing
 * else, so an unattended `cf tick` authenticates with whatever is here. A
 * credential is never in the repo: `CF_ENV_FILE` names a file outside it, and
 * only the two keys above are taken, and only where the environment has a hole.
 */
export function credential(env: Env = process.env): Auth {
  const file = env.CF_ENV_FILE
  const elsewhere = filled(env.ANTHROPIC_BASE_URL)
  if (file !== undefined && file !== '') fill(env, file, elsewhere)
  if (!elsewhere && filled(env.CLAUDE_CODE_OAUTH_TOKEN)) {
    delete env.ANTHROPIC_API_KEY
    return { kind: 'oauth', from: file ?? 'the environment' }
  }
  return { kind: filled(env.ANTHROPIC_API_KEY) ? 'api-key' : 'none', from: file ?? 'the environment' }
}

/**
 * A subscription token aimed at someone else's endpoint is wrong by
 * construction, so when the environment names one the file may not supply it.
 */
function fill(env: Env, file: string, elsewhere: boolean): void {
  const supplied = read(file)
  for (const key of KEYS) {
    const value = supplied.get(key)
    if (value === undefined || filled(env[key])) continue
    if (elsewhere && key === 'CLAUDE_CODE_OAUTH_TOKEN') continue
    env[key] = value
  }
}

function filled(value: string | undefined): boolean {
  return value !== undefined && value !== ''
}

/** `KEY=value` lines. Quotes around a value are dropped; nothing is expanded. */
function read(file: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const split = line.indexOf('=')
    const key = split === -1 ? '' : line.slice(0, split).trim()
    if (key === '' || key.startsWith('#')) continue
    out.set(key, unquote(line.slice(split + 1).trim()))
  }
  return out
}

function unquote(value: string): string {
  const edge = value[0]
  if (edge !== '"' && edge !== "'") return value
  return value.length >= 2 && value.endsWith(edge) ? value.slice(1, -1) : value
}
