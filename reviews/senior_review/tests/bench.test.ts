import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh, rejects } from '../../../checks/sqlite.ts'
import { CAPPED, type Packet, type Provider } from '../../../providers/kind.ts'
import { planRow } from '../../../runner/index.ts'
import { CAP_MAX, STEP_CAP, stepsFor } from '../../../runner/packet.ts'
import { load } from '../../../runner/rules.ts'
import { record } from '../../../store/files.ts'
import { judge, loadReviews, specHash } from '../../bench.ts'
import { read } from '../../verdict.ts'

const root = join(import.meta.dirname, '../../..')
const TRANSCRIPT = join(tmpdir(), 'cf-review.transcript.jsonl')
const repo = '/tmp/cf-review'
const MAPPED = /^# MAP\.md — written by `cf map`\n/

function fixture(review: string, name: string): string {
  return readFileSync(join(root, 'reviews', review, 'fixtures', name), 'utf8')
}

function replies(text: string, cost?: number): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (p) => Promise.resolve({ text, transcript_path: p.transcript, usage: { input: 5, cache: 6, output: 7, ...(cost === undefined ? {} : { cost }) }, seconds: 0.5, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 }),
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

test('refuses the seeded defect by span, passes the clean diff',async () => {
  const { db, plan } = bench(root)
  const refused = await judge(db, root, 'code_quality', plan, seeded(), replies(fixture('code_quality', 'seeded.reply.md')), TRANSCRIPT)
  expect(refused.outcome).toMatchObject({ outcome: 'refuse', defect_class: 'correctness', spans: ['src/stats.ts:2'], origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
  expect(db.prepare('SELECT gate, kind, outcome, origin_kind, origin_ref, tokens FROM verdicts WHERE id = ?').get(refused.verdict))
    .toEqual({ gate: 'review', kind: 'review', outcome: 'refuse', origin_kind: 'ruling', origin_ref: 'reviewers.verdict', tokens: 18 })

  const clean = await judge(db, root, 'code_quality', plan, seeded({ diff: fixture('code_quality', 'clean.diff') }), replies(fixture('code_quality', 'clean.reply.md')), TRANSCRIPT)
  expect(clean.outcome).toMatchObject({ outcome: 'pass', spans: [], defect_class: null })
})

test('a reviewer run writes its cost, NULL when none is reported',async () => {
  const { db, plan } = bench(root)
  const cost = async (provider: Provider): Promise<unknown> => {
    const out = await judge(db, root, 'code_quality', plan, seeded(), provider, TRANSCRIPT)
    return db.prepare('SELECT cost_usd FROM runs WHERE id = ?').get(out.run ?? 0)
  }
  expect(await cost(replies(fixture('code_quality', 'clean.reply.md'), 0.42))).toEqual({ cost_usd: 0.42 })
  expect(await cost(replies(fixture('code_quality', 'clean.reply.md')))).toEqual({ cost_usd: null })
})

const TREE = 'c'.repeat(40)

/** git's word on a second round: the builder moved `src/parse.ts` and left `src/stats.ts` where the reviewer judged it. */
const FROZEN = { changed: ['src/parse.ts'], merged: [], unchanged: [['src/stats.ts', 'b'.repeat(40)]] }

const PRIOR = (span: string): string => `---\noutcome: refuse\nclass: correctness\nspans:\n  - ${span}\n---\n\nthe median is wrong\n`
const AGAIN = (reopen: string): string =>
  `src/stats.ts:2 is still wrong\n\n---\noutcome: refuse\nclass: correctness\nspans:\n  - src/stats.ts:2\n${reopen}---\n`

test('the verdict row carries the tree it judged, and only a tree',async () => {
  const { db, plan } = bench(root)
  const out = await judge(db, root, 'code_quality', plan, seeded({ tree: TREE }), replies(fixture('code_quality', 'clean.reply.md')), TRANSCRIPT)
  expect(db.prepare('SELECT tree FROM verdicts WHERE id = ?').get(out.verdict)).toEqual({ tree: TREE })
  expect(rejects(db, `UPDATE verdicts SET tree = 'not a tree' WHERE id = ${String(out.verdict)}`)).toBe(true)
})

test('a refuse on a path unchanged since last verdict is noted',async () => {
  const { db, plan } = bench(root)
  const noted = await judge(db, root, 'code_quality', plan,
    seeded({ prior: PRIOR('src/stats.ts:9'), narrowing: FROZEN }), replies(AGAIN('')), TRANSCRIPT)
  expect(noted.outcome).toMatchObject({ outcome: 'pass', spans: [], defect_class: null, origin_kind: null, origin_ref: null })
  expect(noted.outcome.message).toContain('Noted, not refused, unchanged since my last verdict:\n  - src/stats.ts:2')
  expect(db.prepare('SELECT outcome FROM verdicts WHERE id = ?').get(noted.verdict)).toEqual({ outcome: 'pass' })
})

test('that span refuses if reopened, named before, or changed',async () => {
  const { db, plan } = bench(root)
  const outcome = async (input: Record<string, unknown>, reply: string): Promise<string> =>
    (await judge(db, root, 'code_quality', plan, input, replies(reply), TRANSCRIPT)).outcome.outcome
  expect(await outcome(seeded({ prior: PRIOR('src/stats.ts:9'), narrowing: FROZEN }),
    AGAIN('reopen:\n  src/stats.ts:2: main merged a second caller that passes no name\n'))).toBe('refuse')
  expect(await outcome(seeded({ prior: PRIOR('src/stats.ts:2'), narrowing: FROZEN }), AGAIN(''))).toBe('refuse')
  expect(await outcome(seeded({ prior: PRIOR('src/stats.ts:9'), narrowing: { ...FROZEN, unchanged: [] } }), AGAIN(''))).toBe('refuse')
})

test('senior review reads the first verdict, names what it missed',async () => {
  const { db, plan } = bench(root)
  const sent: string[] = []
  const capture: Provider = { name: 'claude-agent-sdk', fire: (p) => { sent.push(p.prompt); return replies(fixture('senior_review', 'escape.reply.md')).fire(p) } }
  const second = await judge(db, root, 'senior_review', plan, seeded({ verdict: fixture('senior_review', 'first.verdict.md') }), capture, TRANSCRIPT)
  expect(sent[0]).toMatch(MAPPED)
  expect(sent[0]).toContain('# First verdict')
  expect(sent[0]).toContain('src/stats.ts:2')
  expect(second.outcome.spans).toEqual(['src/stats.ts:4'])
  expect(db.prepare('SELECT gate, step FROM verdicts WHERE id = ?').get(second.verdict)).toEqual({ gate: 'senior_review', step: 5 })
})

test('senior review with reference refuses pay-kit#340 per rule',async () => {
  const { db, plan } = bench(root)
  const sent: string[] = []
  const reference = fixture('senior_review', 'paykit340.reference.md')
  const capture: Provider = { name: 'claude-agent-sdk', fire: (p) => { sent.push(p.prompt); return replies(fixture('senior_review', 'paykit340.reply.md')).fire(p) } }
  const out = await judge(db, root, 'senior_review', plan,
    seeded({ diff: fixture('senior_review', 'paykit340.diff'), verdict: '---\noutcome: pass\n---\n', reference }), capture, TRANSCRIPT)
  expect(sent[0]).toContain(`\n\n# Reference the brief names\n\n${reference}\n\n# First verdict`)
  expect(out.outcome).toMatchObject({ outcome: 'refuse', defect_class: 'correctness',
    spans: ['ruby/lib/pay_kit/config.rb:14', 'ruby/lib/pay_kit/config.rb:27', 'ruby/lib/pay_kit/config.rb:39'],
    origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
  for (const rule of ['yes/no/on/off booleans', 'empty RPC URL as unset', 'non-positive expiry rejected']) expect(out.outcome.message).toContain(rule)
})

test('the prompt carries changed declarations whole in context',async () => {
  const { db, plan } = bench(root)
  const src = mkdtempSync(join(tmpdir(), 'cf-context-'))
  writeFileSync(join(src, 'a.ts'), 'const a = 1\n\nexport function one(): number {\n  return a\n}\n')
  record(db, plan, [{ path: 'a.ts', is_new: false }])
  const sent: string[] = []
  const capture: Provider = { name: 'claude-agent-sdk', fire: (p) => { sent.push(p.prompt); return replies(fixture('code_quality', 'clean.reply.md')).fire(p) } }
  const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -4 +4 @@\n-  return 0\n+  return a\n'
  await judge(db, root, 'code_quality', plan, seeded({ repo: src, diff }), capture, TRANSCRIPT)
  expect(sent[0]).toMatch(/^# MAP\.md — written by `cf map`\n\n- `a\.ts`/)
  expect(sent[0]).toContain('# Changed code in context')
  expect(sent[0]).toContain('## a.ts:3-5\n\n````\nexport function one(): number {\n  return a\n}\n````')
})

test('two defects in two files are one refusal naming both spans',async () => {
  const { db, plan } = bench(root)
  const out = await judge(db, root, 'code_quality', plan, seeded({ diff: fixture('code_quality', 'pair.diff') }),
    replies(fixture('code_quality', 'pair.reply.md')), TRANSCRIPT)
  expect(out.outcome).toMatchObject({ outcome: 'refuse', defect_class: 'correctness', spans: ['src/stats.ts:2', 'src/parse.ts:1'], origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
  expect(out.outcome.message).toContain('scope')
  expect(db.prepare('SELECT count(*) AS n FROM verdicts WHERE plan = ?').get(plan)).toEqual({ n: 1 })
})

test('a replaced function left in place is a minimal refusal', async () => {
  const { db, plan } = bench(root)
  const out = await judge(db, root, 'code_quality', plan, seeded({ diff: fixture('code_quality', 'kept.diff') }),
    replies(fixture('code_quality', 'kept.reply.md')), TRANSCRIPT)
  expect(out.outcome).toMatchObject({ outcome: 'refuse', defect_class: 'minimal', spans: ['src/stats.ts:1'], origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
})

test('reviewer != builder: refused before firing, trigger holds',async () => {
  const { db, plan } = bench(root)
  const builder = `INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens, output_tokens, seconds, exit, transcript_path)
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
  expect(rejects(fresh_.db, `INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens, output_tokens, seconds, exit, transcript_path)
    VALUES (${String(fresh_.plan)}, 5, 'code_quality', '${specHash(root, 'code_quality')}', 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, 'x.transcript.jsonl')`)).toBe(true)
})

test('a verdict fence in a ``` block reads as a bare one',() => {
  const prose = 'Which of the two callers keeps the old name?\n\n'
  for (const bare of ['---\noutcome: refuse\nclass: correctness\nspans:\n  - src/stats.ts:4\n---\n', '---\noutcome: needs_ceo\n---\n']) {
    const wrapped = read(`${prose}\`\`\`yaml\n${bare}\`\`\`\n`, 's')
    expect(wrapped).toEqual(read(prose + bare, 's'))
    expect(wrapped?.message).not.toContain('```')
  }
})

test('a reply with no readable verdict fence is a failed run',async () => {
  for (const reply of ['looks fine to me', '---\noutcome: refuse\n---\n', '---\noutcome: refuse\nclass: correctness\nspans: []\n---\n', '---\n: : :\n---\n',
    '---\noutcome: refuse\nclass: Tests!\nspans:\n  - src/stats.ts:4\n---\n', '---\noutcome: refuse\nclass: test.weakened\nspans:\n  - src/stats.ts:4\n---\n']) {
    expect(read(reply, 'subject')).toBeNull()
    expect(read(`\`\`\`yaml\n${reply}\`\`\`\n`, 'subject')).toBeNull()
  }
  const { db, plan } = bench(root)
  await expect(judge(db, root, 'code_quality', plan, seeded(), replies('looks fine to me'), TRANSCRIPT))
    .rejects.toThrow('reviewers.verdict_fence')
  expect(db.prepare('SELECT exit FROM runs WHERE plan = ?').all(plan)).toEqual([{ exit: 1 }])
  expect(db.prepare('SELECT count(*) AS n FROM verdicts WHERE plan = ?').get(plan)).toEqual({ n: 0 })
})

const NOTE = (kind: string, line = '3', why = '    why: w\n'): string =>
  `  - file: src/stats.ts\n    line: ${line}\n    old: a\n    new: b\n${why}    kind: ${kind}\n`
const PASS = (notes: string): string => `---\noutcome: pass\nnotes:\n${notes}---\n`

test('D1 a pass carries its notes of known kinds as written', () => {
  expect(read(PASS(NOTE('text') + NOTE('count') + NOTE('restore')), 'subject')).toMatchObject({
    outcome: 'pass', spans: [], message: 'pass',
    notes: ['text', 'count', 'restore'].map((kind) => ({ file: 'src/stats.ts', line: 3, old: 'a', new: 'b', why: 'w', kind })),
  })
})

test('D2 a note of unknown kind makes a scope refuse naming it',() => {
  const out = read(`the rest reads fine\n\n${PASS(NOTE('text') + NOTE('logic', '9'))}`, 'subject')
  expect(out).toMatchObject({ outcome: 'refuse', defect_class: 'scope', spans: ['src/stats.ts:9'], notes: [], origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
  expect(out?.message).toBe('the rest reads fine\nnote of no known kind logic at src/stats.ts:9')
})

test('D3 a note with a missing field or non-integer line fails',() => {
  expect(read(PASS(NOTE('text', '3', '')), 'subject')).toBeNull()
  expect(read(PASS(NOTE('text', '3.5')), 'subject')).toBeNull()
})

test('a note value opening with a quoted phrase reads word for word', () => {
  const why = NOTE('text', '3', '    why: "as today" points at the old name\n').replace('old: a', 'old: "x" stays')
  expect(read(PASS(why), 'subject')).toMatchObject({ outcome: 'pass', notes: [{ old: '"x" stays', why: '"as today" points at the old name' }] })
})

test('a single quoted note value reads as today, an unclosed quote fails', () => {
  const spec = '  - file: path/to/file.ts\n    line: 7\n    old: "// adds one to the count"\n    new: ""\n    why: the comment restates its line\n    kind: text\n'
  expect(read(PASS(spec), 'subject')).toMatchObject({ outcome: 'pass', notes: [{ old: '// adds one to the count', new: '' }] })
  expect(read(PASS(NOTE('text', '3', '    why: "as today\n')), 'subject')).toBeNull()
})

test('a refuse of class claim.unverified reads, bare or wrapped', () => {
  const bare = '---\noutcome: refuse\nclass: claim.unverified\nspans:\n  - src/stats.ts:4\n---\n'
  for (const reply of [bare, `\`\`\`yaml\n${bare}\`\`\`\n`]) {
    expect(read(reply, 'subject')).toMatchObject({ outcome: 'refuse', defect_class: 'claim.unverified', spans: ['src/stats.ts:4'], origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
  }
})

test('a pass keeps its prose as message, else reads pass', () => {
  const out = read(`wording only: "fixes" reads "adds"\n\n${PASS(NOTE('text'))}`, 'subject')
  expect(out).toMatchObject({ outcome: 'pass', message: 'wording only: "fixes" reads "adds"', notes: [{ kind: 'text' }] })
  expect(read(PASS(NOTE('text')), 'subject')?.message).toBe('pass')
})

test('a capped run fires once more with no tools for the verdict',async () => {
  const { db, plan } = bench(root)
  const sent: Packet[] = []
  const provider: Provider = {
    name: 'claude-agent-sdk',
    fire: async (p) => {
      sent.push(p)
      const fired = await replies(sent.length === 1 ? 'still reading' : fixture('code_quality', 'seeded.reply.md')).fire(p)
      return sent.length === 1 ? { ...fired, stop_reason: CAPPED, ended: 'stopped', exit: 1 } : fired
    },
  }
  const out = await judge(db, root, 'code_quality', plan, seeded(), provider, TRANSCRIPT)
  expect(sent[0]?.steps).toBe(STEP_CAP)
  expect(sent[1]?.tools).toEqual([])
  expect(sent[1]?.prompt).toMatch(MAPPED)
  expect(out.outcome).toMatchObject({ outcome: 'refuse', spans: ['src/stats.ts:2'], origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
  expect(db.prepare('SELECT exit FROM runs WHERE plan = ? ORDER BY id').all(plan)).toEqual([{ exit: 1 }, { exit: 0 }])
  expect(db.prepare('SELECT max(id) AS id FROM runs WHERE plan = ?').get(plan)).toEqual({ id: out.run })
  expect(db.prepare('SELECT id, outcome, origin_kind, origin_ref, tokens, seconds FROM verdicts WHERE plan = ?').all(plan))
    .toEqual([{ id: out.verdict, outcome: 'refuse', origin_kind: 'ruling', origin_ref: 'reviewers.verdict', tokens: 36, seconds: 1 }])
})

test('a refusal of an unlisted class still refuses with its spans',async () => {
  const reply = fixture('senior_review', 'unlisted.reply.md')
  expect(read(reply, 'subject')).toMatchObject({ outcome: 'refuse', defect_class: 'tests', spans: ['src/stats.ts:4'], origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })

  const { db, plan } = bench(root)
  const out = await judge(db, root, 'senior_review', plan, seeded({ verdict: fixture('senior_review', 'first.verdict.md') }), replies(reply), TRANSCRIPT)
  expect(db.prepare('SELECT exit FROM runs WHERE id = ?').get(out.run ?? 0)).toEqual({ exit: 0 })
  expect(db.prepare('SELECT gate, outcome, origin_kind, origin_ref FROM verdicts WHERE id = ?').get(out.verdict))
    .toEqual({ gate: 'senior_review', outcome: 'refuse', origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
})

test('a refused packet writes its verdict and fires no provider',async () => {
  const { db, plan } = bench(root)
  const never: Provider = { name: 'claude-agent-sdk', fire: () => { throw new Error('the provider was fired on a refused packet') } }
  const out = await judge(db, root, 'code_quality', plan, seeded({ repo: '/Users/michael/Documents/Claude/Projects/crypto-contributor' }), never, TRANSCRIPT)
  expect(out.run).toBeNull()
  expect(db.prepare('SELECT outcome, origin_kind, origin_ref FROM verdicts WHERE id = ?').get(out.verdict))
    .toEqual({ outcome: 'refuse', origin_kind: 'ruling', origin_ref: 'reviewers.maintainers_view' })
})

test('review turns grow with the diff', () => {
  const diff = (n: number): string => ['--- a/x.rs', '+++ b/x.rs', ...Array.from({ length: n }, () => '+line')].join('\n')
  expect(stepsFor(diff(300))).toBe(STEP_CAP)
  expect(stepsFor(diff(777))).toBe(STEP_CAP + 4)
  expect(stepsFor(diff(5000))).toBe(CAP_MAX)
})
