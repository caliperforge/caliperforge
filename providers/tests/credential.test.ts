import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { credential, ENV_FILE, hostValue } from '../credential.ts'

const OAUTH = 'CLAUDE_CODE_OAUTH_TOKEN'
const API = 'ANTHROPIC_API_KEY'
const NOWHERE = join(tmpdir(), 'cf-cred-absent', 'env')

function envFile(body: string, mode = 0o600): string {
  const path = join(mkdtempSync(join(tmpdir(), 'cf-cred-')), 'env')
  writeFileSync(path, body)
  chmodSync(path, mode)
  return path
}

describe('credential', () => {
  it('fills the hole the SDK subprocess would otherwise inherit, and leaves this process alone', () => {
    const env: Record<string, string | undefined> = { CF_ENV_FILE: envFile(`${OAUTH}=abc\n`) }
    const got = credential(env)
    expect(got.auth.kind).toBe('oauth')
    expect(got.env[OAUTH]).toBe('abc')
    expect(env[OAUTH]).toBeUndefined()
  })

  it('leaves a value the environment already carries', () => {
    const env = { CF_ENV_FILE: envFile(`${OAUTH}=file\n`), [OAUTH]: 'inherited' }
    expect(credential(env).env[OAUTH]).toBe('inherited')
  })

  it('takes only the two credential keys, not the rest of the file', () => {
    const env = { CF_ENV_FILE: envFile(`${OAUTH}=abc\nMAIL_IMAP_PASSWORD=zzz\n`) }
    expect(credential(env).env.MAIL_IMAP_PASSWORD).toBeUndefined()
  })

  it('will not read a file anyone but its owner can read', () => {
    const env = { CF_ENV_FILE: envFile(`${OAUTH}=abc\n`, 0o644) }
    expect(credential(env)).toMatchObject({ auth: { kind: 'none', from: 'the environment' } })
  })

  it('falls to the host credential file when nothing names one', () => {
    expect(credential({}, NOWHERE)).toMatchObject({ auth: { kind: 'none', from: 'the environment' } })
    expect(ENV_FILE.endsWith('/.config/caliperforge/env')).toBe(true)
  })
})

describe('credential, choosing between two', () => {
  it('prefers the subscription token and drops the metered key beside it', () => {
    const got = credential({ CF_ENV_FILE: envFile(`${OAUTH}=abc\n${API}=def\n`) })
    expect(got.auth.kind).toBe('oauth')
    expect(got.env[API]).toBeUndefined()
  })

  it('falls to the api key when there is no subscription token', () => {
    const got = credential({ CF_ENV_FILE: envFile(`${API}=def\n`) })
    expect(got.auth.kind).toBe('api-key')
    expect(got.env[API]).toBe('def')
  })

  it('will not aim a subscription token at a third-party endpoint', () => {
    const got = credential({
      CF_ENV_FILE: envFile(`${OAUTH}=abc\n${API}=def\n`),
      ANTHROPIC_BASE_URL: 'https://api.example.com/anthropic',
    })
    expect(got.auth.kind).toBe('api-key')
    expect(got.env[OAUTH]).toBeUndefined()
  })

  it('reads quoted values, skips comments and blank lines', () => {
    expect(credential({ CF_ENV_FILE: envFile(`# a note\n\n${OAUTH}="abc"\n`) }).env[OAUTH]).toBe('abc')
  })

  it('is none when the named file holds nothing and the environment is empty', () => {
    expect(credential({ CF_ENV_FILE: envFile('# nothing\n') }).auth)
      .toEqual({ kind: 'none', from: 'the environment' })
  })
})

describe('hostValue', () => {
  it('reads a key from the environment first, then the file, and is null when neither has it', () => {
    const file = envFile('IMESSAGE_NOTIFY_TO="me@example.com"\n')
    expect(hostValue('IMESSAGE_NOTIFY_TO', {}, file)).toBe('me@example.com')
    expect(hostValue('IMESSAGE_NOTIFY_TO', { IMESSAGE_NOTIFY_TO: 'env@example.com' }, file)).toBe('env@example.com')
    expect(hostValue('IMESSAGE_NOTIFY_TO', {}, NOWHERE)).toBeNull()
  })
})
