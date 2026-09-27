import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { approve as approveCard } from '../../cli/batch.ts'
import type { Pr } from '../../cli/gh.ts'
import { approve } from '../../cli/queue.ts'
import type { Packet } from '../../providers/kind.ts'
import { capture } from '../capture.ts'
import { approve as approvePublish } from '../card.ts'
import { tick } from '../index.ts'
import { maybe } from '../workspace.ts'
import { git } from './bases.ts'
import { CARRIED, plan, PR as URL, SEEDED, stub, watched, world, type World } from './world.ts'

vi.mock('../../cli/gh.ts', async (importOriginal) => ({
  ...await importOriginal<object>(),
  issue: () => ({ number: 12, title: 'hello', body: '- **D1** add `hello()` in `src/hello.ts`', state: 'OPEN', assignees: [],
    comments: [], closedByPullRequestsReferences: [] }),
}))

const SHA = 'a'.repeat(40)
const REVIEWED = `Last reviewed commit: [fix](https://github.com/acme/widget/commit/${SHA})`

const pr = (over: Partial<Pr> = {}): Pr => ({
  number: 7, url: URL, state: 'OPEN', mergedAt: null, mergedBy: null, reviewDecision: null,
  comments: [], reviews: [], statusCheckRollup: [], ...over,
})

const writes = (packet: Packet): void => {
  if (packet.tools.includes('Write')) writeFileSync(join(packet.cwd, 'src/hello.ts'), 'export const hello = (): string => "hey"\n')
}

async function ticks(w: World, id: number, until: () => boolean): Promise<void> {
  for (let at = 0; at < 20 && !until(); at += 1) {
    await tick(w.db, w.root, stub(CARRIED, 0, undefined, writes), undefined, () => pr(), watched([], w.root, id))
  }
}

async function pushed(): Promise<{ w: World; id: number }> {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  const id = Number(approve(w.db, w.root, w.target, 'pr-path').plan)
  await ticks(w, id, () => plan(w.db, id).step === 6)
  const upstream = join(w.root, 'remotes/acme/widget')
  writeFileSync(join(upstream, 'moved.ts'), 'export const moved = 1\n')
  git(upstream, ['add', '-A'])
  git(upstream, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'main moves on'])
  await ticks(w, id, () => plan(w.db, id).step === 7)
  approveCard(w.db, w.root, 'plan', id)
  await ticks(w, id, () => maybe(w.root, id, 'maintainer.md') !== null)
  approvePublish(w.db, w.root, id)
  await ticks(w, id, () => plan(w.db, id).state === 'done')
  return { w, id }
}

const WALK = ['filed', 'ruling', 'build', 'rails', 'review', 'main merged', 'push', 'merge']

test('D4 a job\'s whole life, filed to landed, reads back from events alone', async () => {
  const { w, id } = await pushed()
  capture(w.db, () => pr({ mergedAt: '2026-09-26T09:00:00Z', mergedBy: { login: 'maintainer' } }))
  const rows = w.db.prepare('SELECT kind, message FROM events WHERE plan = ? ORDER BY id').all(id) as { kind: string; message: string }[]
  const stage = (r: { kind: string; message: string }): string =>
    r.kind === 'ready' && r.message.startsWith('main moved; merged it') ? 'main merged' : r.kind
  const found: number[] = []
  for (const kind of WALK) found.push(rows.findIndex((r, i) => i > (found.at(-1) ?? -1) && stage(r) === kind))
  expect(found).not.toContain(-1)
})

test('D1 D2 D3 each stored signal leaves one event pointing at it, once; ours and a headless bot review leave neither', async () => {
  const { w, id } = await pushed()
  const view = pr({
    author: { login: 'caliperforge' },
    comments: [
      { id: 'c1', author: { login: 'maintainer' }, body: 'please split this', createdAt: '2026-09-26T10:00:00Z' },
      { id: 'c2', author: { login: 'caliperforge' }, body: 'split it', createdAt: '2026-09-26T10:30:00Z' },
    ],
    reviews: [
      { id: 'r1', author: { login: 'greptile-apps[bot]' }, body: `score 4/5\n\n${REVIEWED}`, submittedAt: '2026-09-26T11:00:00Z' },
      { id: 'r2', author: { login: 'greptile-apps[bot]' }, body: 'score 3/5', submittedAt: '2026-09-26T11:30:00Z' },
    ],
  })
  const before = (w.db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id
  const since = (): unknown => w.db.prepare('SELECT plan, kind, actor, outcome, message, pointer, run FROM events WHERE id > ? ORDER BY id')
    .all(before)
  capture(w.db, () => view)
  const stored = w.db.prepare('SELECT id, kind, author FROM signals WHERE author != ? ORDER BY id').all(SEEDED) as
    { id: number; kind: string; author: string }[]
  expect(stored.map((s) => [s.kind, s.author])).toEqual([['comment', 'maintainer'], ['bot_review', 'greptile-apps[bot]']])
  expect(since()).toEqual(stored.map((s) => ({ plan: id, kind: s.kind, actor: s.author, outcome: 'pass', message: 'acme/widget#7',
    pointer: `signals:${String(s.id)}`, run: null })))
  const logged = since()
  capture(w.db, () => view)
  expect(since()).toEqual(logged)
})
