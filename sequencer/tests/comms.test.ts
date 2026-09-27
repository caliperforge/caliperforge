import { expect, test } from 'vitest'
import { landed } from '../../cli/batch.ts'
import type { Provider } from '../../providers/kind.ts'
import { facts, gather } from '../../templates/comms.ts'
import { tick } from '../index.ts'
import { FORK, get, put } from '../workspace.ts'
import { plan, reads, world, type World } from './world.ts'

const NAMES = ['gather', 'draft', 'facts', 'text_review', 'desk', 'publish', 'capture']

const refusal = (w: World, blip: number, at = new Date().toISOString().replace('T', ' ').slice(0, 19)): number =>
  Number(w.db.prepare(`INSERT INTO refusals (plan, step, fingerprint, diff, blip, at) VALUES (1, 0, ?, NULL, ?, ?)`)
    .run('0'.repeat(64), blip, at).lastInsertRowid)

const comms = (): World => {
  const w = world()
  w.db.prepare("UPDATE plans SET template = 'comms' WHERE id = 1").run()
  return w
}

const judged = (w: World, line: string): ReturnType<typeof facts> => {
  put(w.root, 1, 'draft.md', `# The day\n\n${line}\n`)
  return facts(w.root, plan(w.db, 1))
}

test('D2: a comms plan ticks gather through capture to done, and no seat or rail runs', async () => {
  const w = comms()
  reads(w.db, 1)
  put(w.root, 1, 'draft.md', `# The day\n\nOne job was refused. [refusal:${String(refusal(w, 0))}]\n`)
  const never: Provider = { name: 'claude-agent-sdk', fire: () => { throw new Error('no seat fires on comms') } }
  for (let n = 0; n < 10 && plan(w.db, 1).state !== 'done'; n += 1) await tick(w.db, w.root, never)
  expect(plan(w.db, 1).state).toBe('done')
  expect(w.db.prepare('SELECT kind, outcome FROM events WHERE plan = 1 ORDER BY id').all())
    .toEqual(NAMES.map((kind) => ({ kind, outcome: 'pass' })))
  expect(w.db.prepare('SELECT (SELECT count(*) FROM runs) + (SELECT count(*) FROM verdicts) AS n').get()).toEqual({ n: 0 })
})

test('D3: facts refuses each line that names an issue, an outside login, or no packet entry', () => {
  const w = comms()
  const id = refusal(w, 0)
  gather(w.db, w.root, plan(w.db, 1))
  for (const line of [`Fixed #12 today. [refusal:${String(id)}]`, `See /issues/12 [refusal:${String(id)}]`,
    `See https://github.com/acme/widget/pull/7 [refusal:${String(id)}]`, `Thanks @someone [refusal:${String(id)}]`,
    'One job was refused.', 'One job was refused. [refusal:999]', 'One job landed. [landed:999]']) {
    expect(judged(w, line)).toMatchObject({ outcome: 'refuse', spans: ['draft.md:3'] })
  }
})

test('D4: facts passes a draft whose every line cites the packet and names no issue or outside login', () => {
  const w = comms()
  const id = refusal(w, 0)
  gather(w.db, w.root, plan(w.db, 1))
  expect(judged(w, `One job was refused. [refusal:${String(id)}]\nThanks @${FORK} [refusal:${String(id)}]`))
    .toMatchObject({ outcome: 'pass', spans: [] })
})

test('D5: gather writes what landed and today\'s refusals, leaving blips and earlier days out', () => {
  const w = comms()
  const today = refusal(w, 0)
  refusal(w, 1)
  refusal(w, 0, '2000-01-01 00:00:00')
  expect(gather(w.db, w.root, plan(w.db, 1))).toMatchObject({ outcome: 'pass', note: '0 landed, 1 refused' })
  const packet = JSON.parse(get(w.root, 1, 'packet.json')) as { landed: unknown[]; refusals: { id: number }[] }
  expect(packet.landed).toEqual(landed(w.db))
  expect(packet.refusals.map((r) => r.id)).toEqual([today])
})
