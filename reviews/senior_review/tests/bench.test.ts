import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh, rejects } from '../../../checks/sqlite.ts'
import { CAPPED, type Packet, type Provider } from '../../../providers/kind.ts'
import { planRow } from '../../../runner/index.ts'
import { STEP_CAP } from '../../../runner/packet.ts'
import { load } from '../../../runner/rules.ts'
import { judge, loadReviews, specHash } from '../../bench.ts'
import { read } from '../../verdict.ts'

const root = join(import.meta.dirname, '../../..')
const TRANSCRIPT = join(tmpdir(), 'cf-review.transcript.jsonl')
const repo = '/tmp/cf-review'

function fixture(review: string, name: string): string {
  return readFileSync(join(root, 'reviews', review, 'fixtures', name), 'utf8')
}

function replies(text: string): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (p) => Promise.resolve({ text, transcript_path: p.transcript, usage: { input: 5, cache: 6, output: 7 }, seconds: 0.5, exit: 0, stop_reason: 'end_turn', denials: 0 }),
  }
}

function bench(root_: string): { db: ReturnType<typeof fresh>; plan: number } {
  const db = fresh(join(root_, 'schema'))
  load(db, root_)
  loadReviews(db, root_)
  return { db, plan: planRow(db) }
}

function seeded(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { repo, issue: fixture('code_quality', 'issue.md'), diff: fixture('code_quality', 'seeded.diff'), ...over }
}

test('the review refuses the seeded defect naming the span, and passes the clean diff', async () => {
  const { db, plan } = bench(root)
  const refused = await judge(db, root, 'code_quality', plan, seeded(), replies(fixture('code_quality', 'seeded.reply.md')), TRANSCRIPT)
  expect(refused.outcome).toMatchObject({ outcome: 'refuse', defect_class: 'correctness', spans: ['src/stats.ts:2'], origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
  expect(db.prepare('SELECT gate, kind, outcome, origin_kind, origin_ref, tokens FROM verdicts WHERE id = ?').get(refused.verdict))
    .toEqual({ gate: 'review', kind: 'review', outcome: 'refuse', origin_kind: 'ruling', origin_ref: 'reviewers.verdict', tokens: 18 })

  const clean = await judge(db, root, 'code_quality', plan, seeded({ diff: fixture('code_quality', 'clean.diff') }), replies(fixture('code_quality', 'clean.reply.md')), TRANSCRIPT)
  expect(clean.outcome).toMatchObject({ outcome: 'pass', spans: [], defect_class: null })
})

test('senior review reads the first verdict and names what the first verdict missed', async () => {
  const { db, plan } = bench(root)
  const sent: string[] = []
  const capture: Provider = { name: 'claude-agent-sdk', fire: (p) => { sent.push(p.prompt); return replies(fixture('senior_review', 'escape.reply.md')).fire(p) } }
  const second = await judge(db, root, 'senior_review', plan, seeded({ verdict: fixture('senior_review', 'first.verdict.md') }), capture, TRANSCRIPT)
  expect(sent[0]).toContain('# First verdict')
  expect(sent[0]).toContain('src/stats.ts:2')
  expect(second.outcome.spans).toEqual(['src/stats.ts:4'])
  expect(db.prepare('SELECT gate, step FROM verdicts WHERE id = ?').get(second.verdict)).toEqual({ gate: 'senior_review', step: 5 })
})

test('two defects in two files come back as one refusal naming both spans', async () => {
  const { db, plan } = bench(root)
  const out = await judge(db, root, 'code_quality', plan, seeded({ diff: fixture('code_quality', 'pair.diff') }),
    replies(fixture('code_quality', 'pair.reply.md')), TRANSCRIPT)
  expect(out.outcome).toMatchObject({ outcome: 'refuse', defect_class: 'correctness', spans: ['src/stats.ts:2', 'src/parse.ts:1'], origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
  expect(out.outcome.message).toContain('scope')
  expect(db.prepare('SELECT count(*) AS n FROM verdicts WHERE plan = ?').get(plan)).toEqual({ n: 1 })
})

test('reviewer != builder is refused before the provider fires; the trigger still guards the rows', async () => {
  const { db, plan } = bench(root)
  const builder = `INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit, transcript_path)
    VALUES (${String(plan)}, 2, 'code_quality', '${specHash(root, 'code_quality')}', 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, 'x.transcript.jsonl')`
  db.exec(builder)
  const never: Provider = { name: 'claude-agent-sdk', fire: () => { throw new Error('the provider was fired on a barred packet') } }
  const barred = await judge(db, root, 'code_quality', plan, seeded(), never, TRANSCRIPT)
  expect(barred.run).toBeNull()
  expect(db.prepare('SELECT outcome, origin_kind, origin_ref, tokens FROM verdicts WHERE id = ?').get(barred.verdict))
    .toEqual({ outcome: 'refuse', origin_kind: 'ruling', origin_ref: 'runs.reviewer_not_builder', tokens: 0 })
  expect(db.prepare('SELECT count(*) AS n FROM runs WHERE plan = ?').get(plan)).toEqual({ n: 1 })

  const fresh_ = bench(root)
  const first = await judge(fresh_.db, root, 'code_quality', fresh_.plan, seeded(), replies(fixture('code_quality', 'seeded.reply.md')), TRANSCRIPT)
  expect(first.run).not.toBeNull()
  expect(rejects(fresh_.db, `UPDATE runs SET seat = 'code_quality' WHERE id = ${String(first.run ?? 0)} AND step = 4`)).toBe(false)
  expect(rejects(fresh_.db, `INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit, transcript_path)
    VALUES (${String(fresh_.plan)}, 5, 'code_quality', '${specHash(root, 'code_quality')}', 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, 'x.transcript.jsonl')`)).toBe(true)
})

test('a reviewer reply with no readable verdict fence is a failed run, not a verdict', async () => {
  for (const reply of ['looks fine to me', '---\noutcome: refuse\n---\n', '---\noutcome: refuse\nclass: correctness\nspans: []\n---\n', '---\n: : :\n---\n',
    '---\noutcome: refuse\nclass: Tests!\nspans:\n  - src/stats.ts:4\n---\n', '---\noutcome: refuse\nclass: test.weakened\nspans:\n  - src/stats.ts:4\n---\n']) {
    expect(read(reply, 'subject')).toBeNull()
  }
  const { db, plan } = bench(root)
  await expect(judge(db, root, 'code_quality', plan, seeded(), replies('looks fine to me'), TRANSCRIPT))
    .rejects.toThrow('reviewers.verdict_fence')
  expect(db.prepare('SELECT exit FROM runs WHERE plan = ?').all(plan)).toEqual([{ exit: 1 }])
  expect(db.prepare('SELECT count(*) AS n FROM verdicts WHERE plan = ?').get(plan)).toEqual({ n: 0 })
})

test('a run that ends at the step cap is fired once more with no tools, and that reply is the verdict', async () => {
  const { db, plan } = bench(root)
  const sent: Packet[] = []
  const provider: Provider = {
    name: 'claude-agent-sdk',
    fire: async (p) => {
      sent.push(p)
      const fired = await replies(sent.length === 1 ? 'still reading' : fixture('code_quality', 'seeded.reply.md')).fire(p)
      return sent.length === 1 ? { ...fired, stop_reason: CAPPED, exit: 1 } : fired
    },
  }
  const out = await judge(db, root, 'code_quality', plan, seeded(), provider, TRANSCRIPT)
  expect(sent[0]?.steps).toBe(STEP_CAP)
  expect(sent[1]?.tools).toEqual([])
  expect(out.outcome).toMatchObject({ outcome: 'refuse', spans: ['src/stats.ts:2'], origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
  expect(db.prepare('SELECT exit FROM runs WHERE plan = ? ORDER BY id').all(plan)).toEqual([{ exit: 1 }, { exit: 0 }])
  expect(db.prepare('SELECT max(id) AS id FROM runs WHERE plan = ?').get(plan)).toEqual({ id: out.run })
  expect(db.prepare('SELECT id, outcome, origin_kind, origin_ref, tokens, seconds FROM verdicts WHERE plan = ?').all(plan))
    .toEqual([{ id: out.verdict, outcome: 'refuse', origin_kind: 'ruling', origin_ref: 'reviewers.verdict', tokens: 36, seconds: 1 }])
})

test('a refusal whose class is not one of the four is still a refusal carrying its spans', async () => {
  const reply = fixture('senior_review', 'unlisted.reply.md')
  expect(read(reply, 'subject')).toMatchObject({ outcome: 'refuse', defect_class: 'tests', spans: ['src/stats.ts:4'], origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })

  const { db, plan } = bench(root)
  const out = await judge(db, root, 'senior_review', plan, seeded({ verdict: fixture('senior_review', 'first.verdict.md') }), replies(reply), TRANSCRIPT)
  expect(db.prepare('SELECT exit FROM runs WHERE id = ?').get(out.run ?? 0)).toEqual({ exit: 0 })
  expect(db.prepare('SELECT gate, outcome, origin_kind, origin_ref FROM verdicts WHERE id = ?').get(out.verdict))
    .toEqual({ gate: 'senior_review', outcome: 'refuse', origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
})

test('a packet the bench refuses writes a refusal verdict and fires no provider', async () => {
  const { db, plan } = bench(root)
  const never: Provider = { name: 'claude-agent-sdk', fire: () => { throw new Error('the provider was fired on a refused packet') } }
  const out = await judge(db, root, 'code_quality', plan, seeded({ repo: '/Users/michael/Documents/Claude/Projects/crypto-contributor' }), never, TRANSCRIPT)
  expect(out.run).toBeNull()
  expect(db.prepare('SELECT outcome, origin_kind, origin_ref FROM verdicts WHERE id = ?').get(out.verdict))
    .toEqual({ outcome: 'refuse', origin_kind: 'ruling', origin_ref: 'reviewers.maintainers_view' })
})
