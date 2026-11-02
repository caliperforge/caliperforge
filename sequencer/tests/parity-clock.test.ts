import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Read } from '../../cli/gh.ts'
import type { Provider } from '../../providers/kind.ts'
import { ofKind, pointers } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { set } from '../../store/lanes.ts'
import { tick } from '../index.ts'

const repo = join(import.meta.dirname, '../..')
const root = mkdtempSync(join(tmpdir(), 'cf-parity-'))
for (const dir of ['rules', 'seats']) cpSync(join(repo, dir), join(root, dir), { recursive: true })
mkdirSync(join(root, 'precedents'))
writeFileSync(join(root, 'precedents/parity.yaml'), 'o/r:\n  contract: Signer\n  files:\n    rust: a.rs\n    go: a.go\n')

function world(): Db {
  const db = fresh(join(repo, 'schema'))
  set(db, 'tick.zone_offset_minutes', '-360', 'ceo', '2026-10-01')
  return db
}

function reader(asked: string[], down = false): Read {
  return (args) => {
    if (!String(args[1]).startsWith('repos/o/r/contents/')) return []
    asked.push(String(args[1]))
    if (down) throw new Error('o/r is down')
    return { size: 4, content: Buffer.from('a\nb\n').toString('base64') }
  }
}

function none(fired: string[]): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (p) => {
      fired.push(p.prompt)
      return Promise.resolve({ text: 'none', transcript_path: p.transcript, usage: { input: 1, cache: 0, output: 1 }, seconds: 0.5,
        ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
}

const at = (db: Db, when: string, provider: Provider, read?: Read): Promise<unknown> =>
  tick(db, root, provider, new Date(when), undefined, undefined, 0, read)

test('D4 the parity scan runs at the first tick of each local week', async () => {
  const db = world()
  const asked: string[] = []
  const fired: string[] = []
  await at(db, '2026-11-01T12:00:00Z', none(fired), reader(asked))
  await at(db, '2026-11-02T12:00:00Z', none(fired), reader(asked))
  expect([asked.length, fired.length]).toEqual([4, 1])
  await at(db, '2026-11-06T12:00:00Z', none(fired), reader(asked))
  expect([asked.length, fired.length]).toEqual([4, 1])
  await at(db, '2026-11-09T12:00:00Z', none(fired), reader(asked))
  expect([asked.length, fired.length]).toEqual([6, 1])
  expect(pointers(db, 'parity_week')).toEqual(['2026-10-26', '2026-11-02', '2026-11-09'])
  expect(ofKind(db, 'parity_week').map((e) => [e.outcome, e.message])).toEqual([['pass', 'o/r 0'], ['pass', 'o/r unchanged'], ['pass', 'o/r unchanged']])
})

test('D5 a thrown scan is logged once and not retried that week', async () => {
  const db = world()
  const asked: string[] = []
  await at(db, '2026-11-02T12:00:00Z', none([]), reader(asked, true))
  await at(db, '2026-11-03T12:00:00Z', none([]), reader(asked, true))
  expect(asked).toHaveLength(1)
  expect(ofKind(db, 'parity_week').map((e) => [e.outcome, e.message])).toEqual([['refuse', 'o/r is down']])
})

test('D6 a tick with no reader runs no parity scan', async () => {
  const db = world()
  const fired: string[] = []
  await at(db, '2026-11-02T12:00:00Z', none(fired))
  expect([ofKind(db, 'parity_week'), fired]).toEqual([[], []])
})
