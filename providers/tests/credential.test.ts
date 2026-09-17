import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { credential } from '../credential.ts'

const OAUTH = 'CLAUDE_CODE_OAUTH_TOKEN'
const API = 'ANTHROPIC_API_KEY'

function envFile(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'cf-cred-')), 'env')
  writeFileSync(path, body)
  return path
}

describe('credential', () => {
  it('fills the hole the SDK subprocess would otherwise inherit', () => {
    const env: Record<string, string | undefined> = { CF_ENV_FILE: envFile(`${OAUTH}=abc\n`) }
    expect(credential(env)).toMatchObject({ kind: 'oauth' })
    expect(env[OAUTH]).toBe('abc')
  })

  it('leaves a value the environment already carries', () => {
    const env: Record<string, string | undefined> = { CF_ENV_FILE: envFile(`${OAUTH}=file\n`), [OAUTH]: 'inherited' }
    credential(env)
    expect(env[OAUTH]).toBe('inherited')
  })

  it('takes only the two credential keys, not the rest of the file', () => {
    const env: Record<string, string | undefined> = { CF_ENV_FILE: envFile(`${OAUTH}=abc\nMAIL_IMAP_PASSWORD=zzz\n`) }
    credential(env)
    expect(env.MAIL_IMAP_PASSWORD).toBeUndefined()
  })

})

describe('credential, choosing between two', () => {
  it('prefers the subscription token and drops the metered key beside it', () => {
    const env: Record<string, string | undefined> = { CF_ENV_FILE: envFile(`${OAUTH}=abc\n${API}=def\n`) }
    expect(credential(env).kind).toBe('oauth')
    expect(env[API]).toBeUndefined()
  })

  it('falls to the api key when there is no subscription token', () => {
    const env: Record<string, string | undefined> = { CF_ENV_FILE: envFile(`${API}=def\n`) }
    expect(credential(env).kind).toBe('api-key')
    expect(env[API]).toBe('def')
  })

  it('will not aim a subscription token at a third-party endpoint', () => {
    const env: Record<string, string | undefined> = {
      CF_ENV_FILE: envFile(`${OAUTH}=abc\n${API}=def\n`),
      ANTHROPIC_BASE_URL: 'https://api.example.com/anthropic',
    }
    expect(credential(env).kind).toBe('api-key')
    expect(env[OAUTH]).toBeUndefined()
  })

  it('reads quoted values, skips comments and blank lines', () => {
    const env: Record<string, string | undefined> = { CF_ENV_FILE: envFile(`# a note\n\n${OAUTH}="abc"\n`) }
    credential(env)
    expect(env[OAUTH]).toBe('abc')
  })

  it('is none when nothing names a file', () => {
    expect(credential({})).toEqual({ kind: 'none', from: 'the environment' })
  })
})
