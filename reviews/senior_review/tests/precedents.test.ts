import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import type { Read } from '../../../cli/gh.ts'
import { row } from '../../../precedents/lookup.ts'
import { distilled, keep, type Precedent } from '../../../precedents/store.ts'
import type { Provider } from '../../../providers/kind.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { reviewed } from '../../../sequencer/precedented.ts'
import { internalPlan, world } from '../../../sequencer/tests/world.ts'
import { SELF } from '../../../sequencer/workspace.ts'
import { record } from '../../../store/files.ts'
import type { Db } from '../../../store/index.ts'
import { planById } from '../../../store/plans.ts'
import { judge, loadReviews } from '../../bench.ts'
import type { Judged } from '../../verdict.ts'

const root = join(import.meta.dirname, '../../..')
const TRANSCRIPT = join(tmpdir(), 'cf-precedents.transcript.jsonl')
const fixture = (review: string, name: string): string => readFileSync(join(root, 'reviews', review, 'fixtures', name), 'utf8')

const at = (n: number, area = 'src/a.rs'): Precedent =>
  ({ area, decision: `d${String(n)}`, why: 'w', said_by: 'm', role: 'maintainer', source: `https://github.com/acme/widget/pull/1#discussion_r${String(n)}` })
const ROWS = [at(1), at(2)]
const [ONE, TWO] = [at(1).source, at(2).source]

const pass = (lines: string): string => `${lines}\n\n---\noutcome: pass\n---\n`
const REFUSE = '---\noutcome: refuse\nclass: scope\nspans:\n  - src/stats.ts:2\n---\n'

async function senior(text: string, extra: Record<string, unknown> = { precedents: ROWS }): Promise<{ outcome: Judged; prompt: string }> {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  loadReviews(db, root)
  const prompts: string[] = []
  const provider: Provider = {
    name: 'claude-agent-sdk',
    fire: (p) => {
      prompts.push(p.prompt)
      return Promise.resolve({ text, transcript_path: p.transcript, usage: { input: 1, cache: 1, output: 1 }, seconds: 0.5, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
  const input = { repo: '/tmp/cf-review', issue: fixture('code_quality', 'issue.md'), diff: fixture('code_quality', 'seeded.diff'),
    verdict: fixture('senior_review', 'first.verdict.md'), ...extra }
  const { outcome } = await judge(db, root, 'senior_review', planRow(db), input, provider, TRANSCRIPT)
  return { outcome, prompt: prompts.join('\n') }
}

const tree = (repo: string): Read => (args) => {
  if (args[1] === `repos/${repo}`) return { default_branch: 'main' }
  if (args[1] === `repos/${repo}/git/trees/main?recursive=1`) return { tree: [{ path: 'src/a.rs' }], truncated: false }
  throw new Error(`unread ${args.join(' ')}`)
}

function stored(db: Db, repo: string): void {
  const source = { repo, number: 1, title: 'T', merged_at: '2026-10-01T00:00:00Z', merger: null, files: ['src/a.rs'], issues: [] }
  keep(db, source, [])
  distilled(db, source, [at(1)], 0)
}

test('D1 the packet prints each precedent row under # Precedents', async () => {
  expect((await senior(pass(`- ${ONE} | kept\n- ${TWO} | kept`))).prompt).toContain(`\n\n# Precedents\n\n${ROWS.map(row).join('\n')}`)
  expect((await senior(pass(''), {})).prompt).not.toContain('\n\n# Precedents\n\n')
})

test('D2 a pass answering one of two rows is refused', async () => {
  const { outcome } = await senior(pass(`- ${ONE} | kept`))
  expect(outcome).toMatchObject({ outcome: 'refuse', defect_class: 'correctness', spans: [TWO],
    findings: [{ span: TWO, kind: 'real', fix: null }], notes: [], origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
  expect(outcome.message).toContain(`Precedents left unanswered:\n  - ${TWO}`)
})

test('D3 kept and changed answers stand, an empty change refuses', async () => {
  expect((await senior(pass(`- ${ONE} | kept\n- ${TWO} | changed: the issue asks for it`))).outcome).toMatchObject({ outcome: 'pass', spans: [] })
  expect((await senior(pass(`- ${ONE} | kept\n- ${TWO} | changed: `))).outcome).toMatchObject({ outcome: 'refuse', spans: [TWO] })
})

test('D4 a refuse with no answers comes through unchanged', async () => {
  expect((await senior(REFUSE)).outcome).toMatchObject({ outcome: 'refuse', defect_class: 'scope', spans: ['src/stats.ts:2'] })
})

test('D5 an outside plan gets its row, an internal plan reads none', async () => {
  const w = world()
  stored(w.db, 'acme/widget')
  stored(w.db, SELF)
  record(w.db, 1, [{ path: 'src/a.rs', is_new: false }])
  expect(reviewed(w.db, planById(w.db, 1), tree('acme/widget'))).toEqual({ precedents: [at(1)] })
  const id = internalPlan(w.db, w.root, 2)
  record(w.db, id, [{ path: 'src/a.rs', is_new: false }])
  const unread: Read = () => { throw new Error('read') }
  const none = reviewed(w.db, planById(w.db, id), unread)
  expect(none).toEqual({})
  expect((await senior(pass(''), none)).prompt).not.toContain('\n\n# Precedents\n\n')
})
