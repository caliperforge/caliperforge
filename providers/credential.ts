import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** What the SDK subprocess will authenticate with, named without its value. */
export interface Auth {
  kind: 'oauth' | 'api-key' | 'none'
  from: string
}

export interface Credential {
  auth: Auth
  env: Env
}

const KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const

/** The host's credential, outside the tree, 600. `CF_ENV_FILE` overrides it. */
export const ENV_FILE = join(homedir(), '.config/caliperforge/env')

type Env = Record<string, string | undefined>

/** `query()` hands the subprocess whatever `options.env` names; a credential reaches the model by no other route. */
export function credential(env: Env = process.env, file: string = fileOf(env)): Credential {
  const supplied = read(file)
  const elsewhere = filled(env.ANTHROPIC_BASE_URL)
  const out: Env = { ...env }
  const took: string[] = []
  for (const key of KEYS) {
    const value = supplied.get(key)
    if (value === undefined || filled(out[key])) continue
    // A subscription token aimed at someone else's endpoint is wrong by construction.
    if (elsewhere && key === 'CLAUDE_CODE_OAUTH_TOKEN') continue
    out[key] = value
    took.push(key)
  }
  const from = took.length === 0 ? 'the environment' : file
  if (!elsewhere && filled(out.CLAUDE_CODE_OAUTH_TOKEN)) {
    delete out.ANTHROPIC_API_KEY
    return { auth: { kind: 'oauth', from }, env: out }
  }
  if (elsewhere) delete out.CLAUDE_CODE_OAUTH_TOKEN
  return { auth: { kind: filled(out.ANTHROPIC_API_KEY) ? 'api-key' : 'none', from }, env: out }
}

/** #251: a host value that is not a credential but must not live in the tree, such as the alert handle. */
export function hostValue(key: string, env: Env = process.env, file: string = fileOf(env)): string | null {
  const value = filled(env[key]) ? env[key] : read(file).get(key)
  return value === undefined || value === '' ? null : value
}

function fileOf(env: Env): string {
  return filled(env.CF_ENV_FILE) ? (env.CF_ENV_FILE ?? ENV_FILE) : ENV_FILE
}

function filled(value: string | undefined): boolean {
  return value !== undefined && value !== ''
}

/**
 * `KEY=value` lines. Quotes around a value are dropped; nothing is expanded. A
 * file anyone but its owner can read is not a credential store, so it is left
 * unread rather than trusted.
 */
function read(file: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of body(file).split('\n')) {
    const split = line.indexOf('=')
    const key = split === -1 ? '' : line.slice(0, split).trim()
    if (key === '' || key.startsWith('#')) continue
    out.set(key, unquote(line.slice(split + 1).trim()))
  }
  return out
}

function body(file: string): string {
  try {
    return (statSync(file).mode & 0o077) === 0 ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

function unquote(value: string): string {
  const edge = value[0]
  if (edge !== '"' && edge !== "'") return value
  return value.length >= 2 && value.endsWith(edge) ? value.slice(1, -1) : value
}
