import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import type { Packet, Provider } from '../../../providers/kind.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { eventsAfter, runRows } from '../../../store/events.ts'
import { verdictRows } from '../../../store/verdict.ts'
import { judge, loadReviews } from '../../bench.ts'
import { broken, read, unfilled } from '../../verdict.ts'

const root = join(import.meta.dirname, '../../..')
const TRANSCRIPT = join(tmpdir(), 'cf-verdict.transcript.jsonl')
const LEAD = 'typescript_specialist'
const BLOCK = { id: 'F1', file: 'src/stats.ts', line: '2', rule: 'tight', required_change: 'mean() divides by the length', verify: 'npm run test -- src/stats.test.ts' }
const SPANS = 'mean() drops the last value\n\n---\noutcome: refuse\nclass: correctness\nspans:\n  - src/stats.ts:2\n---\n'
const SMOKE = 'seats/fizz_lean_generator/tests/smoke.test.ts'
const CHANGE = 'expect(restored(root)).toEqual({ ...MEDUSA, slither: { useSlither: true, cachePath: CACHE } }) — restored() must equal the primed config'
const CODED = `---\noutcome: refuse\nclass: correctness\nfindings:\n  - id: F1\n    file: ${SMOKE}\n    line: 63\n    rule: tight\n    required_change: ${CHANGE}\n    verify: npm run test -- ${SMOKE}\n---\n`
const BROKEN = '---\noutcome: refuse\nclass: correctness: tight\nspans:\n  - src/stats.ts:2\n---\n'

const block = (drop?: string, over: Partial<typeof BLOCK> = {}): string => Object.entries({ ...BLOCK, ...over })
  .filter(([k]) => k !== drop).map(([k, v], i) => `${i === 0 ? '  - ' : '    '}${k}: ${v}\n`).join('')
const refuse = (blocks: string): string => `mean() drops the last value\n\n---\noutcome: refuse\nclass: correctness\nfindings:\n${blocks}---\n`

function fixture(name: string): string {
  return readFileSync(join(root, 'reviews/code_quality/fixtures', name), 'utf8')
}

function replies(text: string): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (p) => Promise.resolve({ text, transcript_path: p.transcript, usage: { input: 5, cache: 6, output: 7 }, seconds: 0.5, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 }),
  }
}

function bench(): { db: ReturnType<typeof fresh>; plan: number } {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  loadReviews(db, root)
  return { db, plan: planRow(db) }
}

const seeded = { repo: '/tmp/cf-review', issue: fixture('issue.md'), diff: fixture('seeded.diff') }

test('D1 a refuse in whole blocks spans each file:line in order', () => {
  expect(read(refuse(block() + block(undefined, { id: 'F2', line: '9' })), 's')).toMatchObject({
    outcome: 'refuse', defect_class: 'correctness', spans: ['src/stats.ts:2', 'src/stats.ts:9'], origin_kind: 'ruling', origin_ref: 'reviewers.verdict',
  })
})

test('D1 each block is a row after the prose; spans add none', () => {
  expect(read(refuse(block() + block(undefined, { id: 'F2', line: '9' })), 's')?.message).toBe('mean() drops the last value\n\n'
    + '- F1 src/stats.ts:2 tight: mean() divides by the length; verify: npm run test -- src/stats.test.ts\n'
    + '- F2 src/stats.ts:9 tight: mean() divides by the length; verify: npm run test -- src/stats.test.ts')
  expect(read(SPANS, 's')?.message).toBe('mean() drops the last value')
})

test('code in an unquoted required_change reads its finding', () => {
  expect(read(CODED, 's')).toMatchObject({ outcome: 'refuse', spans: [`${SMOKE}:63`],
    message: `- F1 ${SMOKE}:63 tight: ${CHANGE}; verify: npm run test -- ${SMOKE}` })
})

test('a fence broken past both repairs reads null', () => {
  expect(read(BROKEN, 's')).toBeNull()
  expect(broken(BROKEN)).toBe('Nested mappings are not allowed in compact mappings at line 2, column 8:')
})

test('D2 unfilled passes a pass, a needs_ceo and whole blocks', () => {
  for (const reply of ['---\noutcome: pass\n---\n', '---\noutcome: needs_ceo\n---\n', refuse(block())]) expect(unfilled(reply)).toBeNull()
})

test.each(['id', 'file', 'line', 'rule', 'required_change', 'verify'])('D3 a block without %s is named and not read', (field) => {
  expect(read(refuse(block()), 's')).not.toBeNull()
  const dropped = refuse(block(field))
  expect(unfilled(dropped)).toBe(field === 'id' ? 'finding 1 has no id' : `F1 has no ${field}`)
  expect(read(dropped, 's')).toBeNull()
})

test('D4 under a lead a block missing verify fails the run', async () => {
  const { db, plan } = bench()
  await expect(judge(db, root, 'code_quality', plan, seeded, replies(refuse(block('verify'))), TRANSCRIPT, LEAD))
    .rejects.toThrow('reviewers.verdict_fence: F1 has no verify')
  expect(runRows(db).filter((r) => r.plan === plan).map(({ exit }) => ({ exit }))).toEqual([{ exit: 1 }, { exit: 1 }])
  expect(verdictRows(db, plan)).toHaveLength(0)
})

test('a fenceless answer is asked once more for its fence', async () => {
  const { db, plan } = bench()
  const sent: Packet[] = []
  const provider: Provider = { name: 'claude-agent-sdk', fire: (p) => { sent.push(p); return replies(sent.length === 1 ? 'looks fine to me' : refuse(block())).fire(p) } }
  const out = await judge(db, root, 'code_quality', plan, seeded, provider, TRANSCRIPT, LEAD)
  expect(out.outcome).toMatchObject({ outcome: 'refuse', spans: ['src/stats.ts:2'], origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
  const runs = runRows(db).filter((r) => r.plan === plan)
  expect(runs.map(({ exit }) => ({ exit }))).toEqual([{ exit: 1 }, { exit: 0 }])
  expect(out.run).toBe(runs[1]?.id)
  expect(sent[1]?.tools).toEqual([])
  expect(sent[1]?.prompt).toBe(`${sent[0]?.prompt ?? ''}\n\n# Your answer\n\nlooks fine to me\n\n`
    + 'Restate the verdict above in the fence your instructions give, and nothing else.')
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'review')).toEqual([{ plan, kind: 'review', actor: 'code_quality', outcome: 'pass',
    message: 'code_quality refired for the verdict fence', pointer: null, run: runs[0]?.id }])
  expect(verdictRows(db, plan)).toHaveLength(1)
})

test('the refire for a broken fence names its YAML error', async () => {
  const { db, plan } = bench()
  const sent: Packet[] = []
  const provider: Provider = { name: 'claude-agent-sdk', fire: (p) => { sent.push(p); return replies(sent.length === 1 ? BROKEN : refuse(block())).fire(p) } }
  await judge(db, root, 'code_quality', plan, seeded, provider, TRANSCRIPT, LEAD)
  expect(sent[1]?.prompt.endsWith(`${BROKEN}\n\nYour fence does not parse: ${broken(BROKEN) ?? ''}\n`
    + 'Write a value that carries code as one JSON string on its line.\n\n'
    + 'Restate the verdict above in the fence your instructions give, and nothing else.')).toBe(true)
})

test('D5 a spans-only refuse names findings under a lead only', async () => {
  const { db, plan } = bench()
  await expect(judge(db, root, 'code_quality', plan, seeded, replies(SPANS), TRANSCRIPT, LEAD))
    .rejects.toThrow('reviewers.verdict_fence: refuse has no findings')
  const unled = await judge(db, root, 'code_quality', plan, seeded, replies(SPANS), TRANSCRIPT)
  expect(unled.outcome).toMatchObject({ outcome: 'refuse', spans: ['src/stats.ts:2'], origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
})
