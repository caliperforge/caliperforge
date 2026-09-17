import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import type { Provider } from '../../../providers/kind.ts'
import { audit, record } from '../../../rails/completion-audit/index.ts'
import { fire } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { settle } from '../../../store/dispositions.ts'
import type { Db } from '../../../store/index.ts'
import { judge, loadReviews } from '../../bench.ts'

const root = join(import.meta.dirname, '../../..')
const TRANSCRIPT = join(tmpdir(), 'cf-review.transcript.jsonl')
const evidence = 'https://github.com/caliperforge/caliperforge/issues/8'

const HANDBACK = `---
ticket_id: T-P4-MEDIAN
seat: typescript_specialist
status: done
exit_code: 0
commit: none
done:
  - id: D1
    status: done
    pointer: src/stats.ts:1
---
`

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '../fixtures', name), 'utf8')
}

function body(diff: string): string {
  return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n')
}

function replies(text: string): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (p) => Promise.resolve({ text, transcript_path: p.transcript, usage: { input: 9, cache: 0, output: 4 }, seconds: 0.2, exit: 0, stop_reason: 'end_turn', denials: 0 }),
  }
}

function checkout(diff: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-e2e-'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/stats.ts'), `${body(diff)}\n`)
  return dir
}

function span(dir: string, line: number): string {
  return readFileSync(join(dir, 'src/stats.ts'), 'utf8').split('\n')[line - 1] ?? ''
}

function bench(): { db: Db; repo: string } {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  loadReviews(db, root)
  return { db, repo: checkout(fixture('seeded.diff')) }
}

async function built(db: Db, repo: string): Promise<number> {
  const run = await fire(db, root, 'typescript_specialist', repo, fixture('issue.md'), replies(HANDBACK))
  const plan = db.prepare('SELECT plan FROM runs WHERE id = ?').get(run.id) as { plan: number }
  const rail = audit(run.text, ['D1'])
  expect(rail.outcome).toBe('pass')
  record(db, plan.plan, rail, 0.01)
  return plan.plan
}

test('seeded defect: builder, rail, review refuses the span, fix, re-gate, dispositions.fixed', async () => {
  const { db, repo } = bench()
  const plan = await built(db, repo)
  const packet = { repo, issue: fixture('issue.md'), diff: fixture('seeded.diff') }

  const refused = await judge(db, root, 'code_quality', plan, packet, replies(fixture('seeded.reply.md')), TRANSCRIPT)
  expect(refused.outcome).toMatchObject({ outcome: 'refuse', defect_class: 'correctness', spans: ['src/stats.ts:2'], origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })

  const before = span(repo, 2)
  writeFileSync(join(repo, 'src/stats.ts'), `${body(fixture('clean.diff'))}\n`)
  const after = span(repo, 2)
  expect(after).not.toBe(before)

  const regate = await judge(db, root, 'code_quality', plan, { ...packet, diff: fixture('clean.diff') }, replies(fixture('clean.reply.md')), TRANSCRIPT)
  expect(regate.outcome.outcome).toBe('pass')

  const id = settle(db, { verdict_id: refused.verdict, defect_class: 'correctness', evidence }, before, after, regate.outcome.outcome)
  expect(db.prepare('SELECT kind, owner, defect_class FROM dispositions WHERE id = ?').get(id ?? 0))
    .toEqual({ kind: 'fixed', owner: 'review', defect_class: 'correctness' })
  expect(db.prepare('SELECT gate, outcome, origin_kind, origin_ref FROM verdicts WHERE plan = ? ORDER BY id').all(plan)).toEqual([
    { gate: 'pre_review', outcome: 'pass', origin_kind: null, origin_ref: null },
    { gate: 'review', outcome: 'refuse', origin_kind: 'ruling', origin_ref: 'reviewers.verdict' },
    { gate: 'review', outcome: 'pass', origin_kind: null, origin_ref: null },
  ])
})

test('clean run: no refusal anywhere and nothing to settle', async () => {
  const { db } = bench()
  const repo = checkout(fixture('clean.diff'))
  const plan = await built(db, repo)
  const clean = await judge(db, root, 'code_quality', plan, { repo, issue: fixture('issue.md'), diff: fixture('clean.diff') }, replies(fixture('clean.reply.md')), TRANSCRIPT)
  expect(clean.outcome.outcome).toBe('pass')
  expect(db.prepare("SELECT count(*) AS n FROM verdicts WHERE plan = ? AND outcome <> 'pass'").get(plan)).toEqual({ n: 0 })
  expect(db.prepare('SELECT count(*) AS n FROM dispositions').get()).toEqual({ n: 0 })
})
