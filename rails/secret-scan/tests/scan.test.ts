import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { record } from '../../record.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { scan } from '../index.ts'

const root = join(import.meta.dirname, '../../..')

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, name), 'utf8')
}

test('refuses a diff carrying a key and a .env, naming both spans', () => {
  const verdict = scan(fixture('red.diff'))
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.origin_kind).toBe('rail')
  expect(verdict.origin_ref).toBe('secret-scan')
  expect(verdict.spans).toEqual(['.env:1 secret.env_file', 'src/client.ts:5 secret.aws_key'])
})

test('passes a diff that reads its credentials from the environment', () => {
  const verdict = scan(fixture('green.diff'))
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('names the pattern for each credential shape', () => {
  const shapes = [
    ['ghp_0123456789abcdefghijklmnopqrstuvwxyz', 'secret.github_token'],
    ['sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA', 'secret.api_key'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'secret.private_key'],
    ['xoxb-1234567890-abcdefghij', 'secret.slack_token'],
    ["password: 'correcthorsebatterystaple'", 'secret.assignment'],
  ]
  for (const [text, name] of shapes) {
    const verdict = scan(`--- a/x.ts\n+++ b/x.ts\n@@ -1,0 +1,1 @@\n+${String(text)}\n`)
    expect(verdict.spans).toEqual([`x.ts:1 ${String(name)}`])
  }
})

test('writes a verdicts row the store accepts', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const id = record(db, join(import.meta.dirname, '..'), plan, scan(fixture('red.diff')), 0.01)
  const row = db.prepare('SELECT gate, kind, outcome, rail_id, origin_kind, origin_ref FROM verdicts WHERE id = ?').get(id)
  expect(row).toEqual({ gate: 'pre_review', kind: 'rail', outcome: 'refuse', rail_id: 'secret-scan', origin_kind: 'rail', origin_ref: 'secret-scan' })
})
