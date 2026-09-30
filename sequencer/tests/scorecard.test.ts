import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { all } from '../../cli/inbox.ts'
import type { Provider } from '../../providers/kind.ts'
import { SCORECARD_COLUMNS, score } from '../../templates/comms.ts'
import { tick } from '../index.ts'
import { mapOf } from '../steps.ts'
import { plan, world, type World } from './world.ts'

const { subscribers, open_rate: openRate, sources } = SCORECARD_COLUMNS

const scoring = (): World => {
  const w = world()
  w.db.prepare("UPDATE plans SET template = 'comms', step = 9, title = 'scorecard 2026-10-05' WHERE id = 1").run()
  return w
}

const dropped = (w: World, name: string, text: string): void => {
  mkdirSync(join(w.root, '.cf/growth/stats'), { recursive: true })
  writeFileSync(join(w.root, '.cf/growth/stats', name), text)
}

const csv = (rows: string[][]): string => rows.map((r) => `${r.join(',')}\n`).join('')

const scored = (w: World): ReturnType<typeof score> => score(w.db, w.root, plan(w.db, 1), mapOf('comms').at(9))

const post = (w: World, id: number, kind: string, dest: string, body: string, day: string, edited: string | null = null): void => {
  w.db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, edited_body, sources, checks, work_date, written_date, proof_at)
    VALUES (?, ?, ?, 'proof', 't', '', ?, ?, '[]', '[]', ?, ?, ?)`).run(id, kind, dest, body, edited, day, day, `${day} 09:00:00`)
}

const cards = (w: World): { id: number; title: string; dek: string; body: string; work_date: string }[] =>
  w.db.prepare("SELECT id, title, dek, body, work_date FROM desk_posts WHERE kind = 'scorecard' AND id = 1").all() as
    { id: number; title: string; dek: string; body: string; work_date: string }[]

const notes = (n: number): string => JSON.stringify({ notes: Array.from({ length: n }, () => 'a note') })

test('the week\'s inputs give one full scorecard row with deltas', () => {
  const w = scoring()
  dropped(w, '2026-09-28.csv', csv([[subscribers, openRate], ['1', '1%']]))
  dropped(w, '2026-10-04.csv', csv([[subscribers, openRate, sources], ['1200', '40%', 'substack'], ['1204', '41%', 'twitter'],
    ['1204', '41%', 'substack'], ['1204', '41%', '']]))
  dropped(w, '2026-10-04.swaps', '2\n')
  post(w, 2, 'growth', 'pack', notes(3), '2026-10-01', notes(14))
  post(w, 3, 'ship', 'substack', 'b', '2026-10-02')
  post(w, 4, 'scorecard', 'scorecard', JSON.stringify({ subscribers: 1150, open_rate: 38, notes_ready: 10, swaps: 1 }), '2026-09-21')
  expect(scored(w)).toMatchObject({ outcome: 'pass' })
  const [row] = cards(w)
  expect(cards(w)).toHaveLength(1)
  expect(row).toMatchObject({ title: 'scorecard/2026-09-28', work_date: '2026-09-28',
    dek: 'post y · 14 Notes · swaps 2 · 1204 subscribers · open rate 41 · sources 2' })
  expect(JSON.parse(row?.body ?? 'null')).toEqual({ post_by_friday: 'y', notes_ready: 14, swaps: 2, subscribers: 1204, open_rate: 41,
    sources: { substack: 2, twitter: 1 }, change: { subscribers: 54, open_rate: 3, notes_ready: 4, swaps: 1 } })
})

test('a CSV without Open rate is refused on its path, no row', () => {
  const w = scoring()
  dropped(w, '2026-10-04.csv', csv([[subscribers, sources], ['1204', 'substack']]))
  const got = scored(w)
  expect(got).toMatchObject({ outcome: 'refuse', spans: ['.cf/growth/stats/2026-10-04.csv'] })
  expect(got.note).toContain(openRate)
  expect(cards(w)).toEqual([])
})

test('no .swaps file or Source column: the row says not recorded', () => {
  const w = scoring()
  dropped(w, '2026-10-04.csv', csv([[subscribers, openRate], ['1204', '41']]))
  expect(scored(w)).toMatchObject({ outcome: 'pass' })
  const [row] = cards(w)
  expect(row?.dek).toBe('post n · 0 Notes · swaps not recorded · 1204 subscribers · open rate 41 · sources not in export')
  expect(JSON.parse(row?.body ?? 'null')).toEqual({ post_by_friday: 'n', notes_ready: 0, swaps: null, subscribers: 1204, open_rate: 41,
    sources: 'not in export', change: null })
})

test('a week with no CSV writes no row and one late inbox line', () => {
  const w = scoring()
  dropped(w, '2026-09-21.csv', csv([[subscribers, openRate], ['1', '1']]))
  dropped(w, '2026-10-05.csv', csv([[subscribers, openRate], ['1', '1']]))
  expect(scored(w)).toMatchObject({ outcome: 'pass', note: 'no stats CSV for week 2026-09-28' })
  expect(cards(w)).toEqual([])
  expect(all(w.root)).toMatchObject([{ plan: 1, kind: 'late', step: 9, name: 'score', note: 'no stats CSV for week 2026-09-28' }])
})

const never: Provider = { name: 'claude-agent-sdk', fire: () => { throw new Error('no seat fires on comms') } }

test('two ticks on one local Monday file one scorecard plan', async () => {
  const w = world()
  w.db.prepare("UPDATE plans SET state = 'done' WHERE id = 1").run()
  w.db.prepare(`INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent)
    VALUES ('comms', 1, '07:00', '20:00', 1)`).run()
  await tick(w.db, w.root, never, new Date('2026-10-06T03:00Z'))
  await tick(w.db, w.root, never, new Date('2026-10-06T03:30Z'))
  expect(w.db.prepare(`SELECT p.title, p.state, e.actor FROM plans p JOIN events e ON e.plan = p.id AND e.kind = 'filed'
    WHERE p.title LIKE 'scorecard %'`).all()).toEqual([{ title: 'scorecard 2026-10-05', state: 'queued', actor: 'weekly clock' }])
})
