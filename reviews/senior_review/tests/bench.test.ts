import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh, rejects } from '../../../checks/sqlite.ts'
import type { Provider } from '../../../providers/kind.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { judge, loadReviews, specHash } from '../../bench.ts'
import { read } from '../../verdict.ts'

const root = join(import.meta.dirname, '../../..')
const repo = '/tmp/cf-review'

function fixture(review: string, name: string): string {
  return readFileSync(join(root, 'reviews', review, 'fixtures', name), 'utf8')
}

function replies(text: string): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: () => Promise.resolve({ text, usage: { input: 5, cache: 6, output: 7 }, seconds: 0.5, exit: 0, stop_reason: 'end_turn', denials: 0 }),
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
  const refused = await judge(db, root, 'code_quality', plan, seeded(), replies(fixture('code_quality', 'seeded.reply.md')))
  expect(refused.outcome).toMatchObject({ outcome: 'refuse', defect_class: 'correctness', spans: ['src/stats.ts:2'], origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
  expect(db.prepare('SELECT gate, kind, outcome, origin_kind, origin_ref, tokens FROM verdicts WHERE id = ?').get(refused.verdict))
    .toEqual({ gate: 'review', kind: 'review', outcome: 'refuse', origin_kind: 'ruling', origin_ref: 'reviewers.verdict', tokens: 18 })

  const clean = await judge(db, root, 'code_quality', plan, seeded({ diff: fixture('code_quality', 'clean.diff') }), replies(fixture('code_quality', 'clean.reply.md')))
  expect(clean.outcome).toMatchObject({ outcome: 'pass', spans: [], defect_class: null })
})

test('senior review reads the first verdict and names what the first verdict missed', async () => {
  const { db, plan } = bench(root)
  const sent: string[] = []
  const capture: Provider = { name: 'claude-agent-sdk', fire: (p) => { sent.push(p.prompt); return replies(fixture('senior_review', 'escape.reply.md')).fire(p) } }
  const second = await judge(db, root, 'senior_review', plan, seeded({ verdict: fixture('senior_review', 'first.verdict.md') }), capture)
  expect(sent[0]).toContain('# First verdict')
  expect(sent[0]).toContain('src/stats.ts:2')
  expect(second.outcome.spans).toEqual(['src/stats.ts:4'])
  expect(db.prepare('SELECT gate, step FROM verdicts WHERE id = ?').get(second.verdict)).toEqual({ gate: 'senior_review', step: 5 })
})

test('reviewer != builder fires on the runs rows the bench writes', async () => {
  const { db, plan } = bench(root)
  const builder = `INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit)
    VALUES (${String(plan)}, 2, 'code_quality', '${specHash(root, 'code_quality')}', 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0)`
  db.exec(builder)
  await expect(judge(db, root, 'code_quality', plan, seeded(), replies(fixture('code_quality', 'seeded.reply.md'))))
    .rejects.toThrow(/reviewer != builder/)

  const fresh_ = bench(root)
  const first = await judge(fresh_.db, root, 'code_quality', fresh_.plan, seeded(), replies(fixture('code_quality', 'seeded.reply.md')))
  expect(first.run).not.toBeNull()
  expect(rejects(fresh_.db, `UPDATE runs SET seat = 'code_quality' WHERE id = ${String(first.run ?? 0)} AND step = 4`)).toBe(false)
  expect(rejects(fresh_.db, `INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit)
    VALUES (${String(fresh_.plan)}, 5, 'code_quality', '${specHash(root, 'code_quality')}', 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0)`)).toBe(true)
})

test('a reviewer reply with no readable verdict fence refuses rather than passes', () => {
  for (const reply of ['looks fine to me', '---\noutcome: refuse\n---\n', '---\noutcome: refuse\nclass: correctness\nspans: []\n---\n', '---\n: : :\n---\n']) {
    expect(read(reply, 'subject')).toMatchObject({ outcome: 'refuse', origin_kind: 'ruling', origin_ref: 'reviewers.verdict_fence' })
  }
})

test('a packet the bench refuses writes a refusal verdict and fires no provider', async () => {
  const { db, plan } = bench(root)
  const never: Provider = { name: 'claude-agent-sdk', fire: () => { throw new Error('the provider was fired on a refused packet') } }
  const out = await judge(db, root, 'code_quality', plan, seeded({ repo: '/Users/michael/Documents/Claude/Projects/crypto-contributor' }), never)
  expect(out.run).toBeNull()
  expect(db.prepare('SELECT outcome, origin_kind, origin_ref FROM verdicts WHERE id = ?').get(out.verdict))
    .toEqual({ outcome: 'refuse', origin_kind: 'ruling', origin_ref: 'reviewers.maintainers_view' })
})
