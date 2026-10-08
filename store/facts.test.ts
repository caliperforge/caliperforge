import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import type { Issue, Read } from '../cli/gh.ts'
import { fresh } from '../checks/sqlite.ts'
import { planRow } from '../runner/index.ts'
import { load } from '../runner/rules.ts'
import { MAIN, OPERATOR, put, srcDir } from '../sequencer/workspace.ts'
import { logged, runAt } from './events.ts'
import { ciFacts, diffFacts, facts, greptileFacts, ruleFacts, testFacts, type Fact } from './facts.ts'
import type { Db } from './index.ts'
import { record } from './signals.ts'

const root = join(import.meta.dirname, '..')

function verdict(db: Db, plan: number, gate: string, rail: string | null, outcome: string): void {
  const origin = outcome === 'refuse' ? 'rail' : null
  db.prepare(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds)
    VALUES (?, ?, ?, ?, 3, ?, ?, ?, ?, 0, 0)`)
    .run(gate, rail === null ? 'review' : 'rail', 'a'.repeat(64), plan, outcome, rail, origin, origin && 'x')
}

function passing(): { db: Db; plan: number } {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  verdict(db, plan, 'pre_review', 'tight', 'pass')
  verdict(db, plan, 'pre_review', 'identifiers', 'pass')
  verdict(db, plan, 'review', null, 'pass')
  verdict(db, plan, 'senior_review', null, 'pass')
  return { db, plan }
}

const PASS = ['rails', 'code_quality', 'senior', 'identifiers'].map((name) => ({ name, ok: true, says: 'pass' }))

test('D1 four passing gates and two builds', () => {
  const { db, plan } = passing()
  const run = runAt(db, plan, 2, 'typescript_specialist', '2026-09-21T00:00:00.000Z')
  for (let i = 0; i < 2; i++) {
    logged(db, { plan, kind: 'build', actor: 'typescript_specialist', outcome: 'pass', message: '', pointer: null, run })
  }
  expect(facts(db, plan)).toEqual([...PASS, { name: 'builds', ok: true, says: '2 builds' }])
})

test('D2 a refused review fails code_quality only', () => {
  const { db, plan } = passing()
  verdict(db, plan, 'review', null, 'refuse')
  expect(facts(db, plan).slice(0, 4)).toEqual([PASS[0], { name: 'code_quality', ok: false, says: 'refuse' }, PASS[2], PASS[3]])
})

test('D3 a refused tight fails rails, not identifiers', () => {
  const { db, plan } = passing()
  verdict(db, plan, 'pre_review', 'tight', 'refuse')
  expect(facts(db, plan).slice(0, 4)).toEqual([{ name: 'rails', ok: false, says: 'tight refuse' }, ...PASS.slice(1)])
  verdict(db, plan, 'pre_review', 'tight', 'pass')
  verdict(db, plan, 'pre_review', 'identifiers', 'refuse')
  expect(facts(db, plan).slice(0, 4)).toEqual([...PASS.slice(0, 3), { name: 'identifiers', ok: false, says: 'refuse' }])
})

test('D4 an empty plan has no verdict on any gate', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const none = PASS.map(({ name }) => ({ name, ok: false, says: 'no verdict' }))
  expect(facts(db, plan)).toEqual([...none, { name: 'builds', ok: true, says: '0 builds' }])
})

const DIFF = [
  '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1,4 @@',
  '-const a = 1', '+// one', '+const a = 2', '+', '+const b = 3',
  '--- a/src/a.test.ts', '+++ b/src/a.test.ts', '@@ -1 +1,2 @@',
  '-  expect(a).toBe(1)', '+  // two', '+  expect(a).toBe(2)',
  '--- a/tool/b.py', '+++ b/tool/b.py', '@@ -1,2 +1 @@',
  '-# three', '-x = 1', '+  ',
  '--- a/old.test.ts', '+++ /dev/null', '@@ -1 +0,0 @@',
  "-test('old', () => {})",
].join('\n')

const run = (n: number): string => `https://github.com/o/r/actions/runs/${String(n)}`

test('D1 D2 diffFacts counts each line once, blanks nowhere', () => {
  expect(diffFacts(DIFF)).toEqual([
    { name: 'files', ok: true, says: '4 files' },
    { name: 'code', ok: true, says: '+2 -2' },
    { name: 'tests', ok: true, says: '+1 -2' },
    { name: 'comments', ok: true, says: '+2 -1 (.ts +2 -0, .py +0 -1)' },
  ])
})

test('D3 testFacts reads local checks and gating fork runs', () => {
  const { db, plan } = passing()
  verdict(db, plan, 'pre_review', 'checks', 'refuse')
  verdict(db, plan, 'pre_review', 'checks', 'pass')
  const board = [
    { workflow: 'Test', status: 'completed', conclusion: 'success', gates: true, url: run(1) },
    { workflow: 'Build', status: 'completed', conclusion: 'failure', gates: true, url: run(2) },
    { workflow: 'Python', status: 'completed', conclusion: 'failure', gates: false, url: run(3) },
  ]
  const tests = { name: 'tests changed', ok: true, says: '1 test files added or changed' }
  const local = { name: 'local', ok: true, says: 'pass' }
  expect(testFacts(db, plan, DIFF, board)).toEqual([tests, local, { name: 'fork', ok: false, says: `${run(1)}, ${run(2)}` }])
  const none = { name: 'fork', ok: true, says: "no fork CI; step 3's checks stand as it" }
  expect(testFacts(db, plan, DIFF, null)).toEqual([tests, local, none])
})

test('D4 D5 D6 ciFacts gives one row per workflow', () => {
  const red = { status: 'completed', conclusion: 'failure', gates: true }
  expect(ciFacts([
    { workflow: 'Test', status: 'completed', conclusion: 'success', gates: true, url: run(1) },
    { ...red, workflow: 'validate', base: ['validate: Install'], url: run(2) },
    { ...red, workflow: 'Verify signatures', url: run(3) },
    { ...red, workflow: 'Build', url: run(4) },
    { ...red, workflow: 'Python', gates: false, url: run(5) },
    { workflow: 'Lint', status: 'in_progress', conclusion: '', gates: true, url: run(6) },
  ])).toEqual([
    { name: 'Test', ok: true, says: `green ${run(1)}` },
    { name: 'validate', ok: true, says: 'red on the base too (validate: Install)' },
    { name: 'Verify signatures', ok: true, says: 'red, expected on a fork: signing' },
    { name: 'Build', ok: false, says: `red ${run(4)}` },
    { name: 'Python', ok: true, says: 'red, not judged: the diff touches no file it runs on' },
    { name: 'Lint', ok: false, says: 'still running' },
  ])
})

const HEAD = 'a'.repeat(40)

function greptiled(files: Record<string, string>): { db: Db; dir: string; plan: number } {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const dir = mkdtempSync(join(tmpdir(), 'cf-facts-'))
  for (const [name, body] of Object.entries(files)) put(dir, plan, name, body)
  return { db, dir, plan }
}

test('D1 D2 greptileFacts gives score and each ruling', () => {
  const { db, dir, plan } = greptiled({ [`findings-${HEAD}.md`]: '- G1 src/a.ts:1 x\n- G2 src/a.ts:2 y\n',
    'rulings.md': `accepted:\n  head: ${HEAD.slice(0, 12)}\n  ids: G2\n  reason: recorded upstream\n`,
    'step-2.handback.md': '---\ndone:\n  - id: G1\n    status: done\n    pointer: src/a.ts:3\n---\n' })
  record(db, { repo: 'o/r', pr: 1, kind: 'bot_review', author: 'greptile-apps[bot]', at: '2026-10-08T00:00:00Z',
    external_id: 'x', score: 4, plan, head: HEAD })
  expect(greptileFacts(db, dir, plan, HEAD)).toEqual([
    { name: 'greptile', ok: true, says: '4/5' },
    { name: 'findings', ok: true, says: '2 findings' },
    { name: 'G1', ok: true, says: 'fixed: src/a.ts:3' },
    { name: 'G2', ok: true, says: 'accepted: recorded upstream' },
  ])
  put(dir, plan, `findings-${HEAD}.md`, '- G1 src/a.ts:1 x\n- G2 src/a.ts:2 y\n- G3 src/a.ts:3 z\n')
  expect(greptileFacts(db, dir, plan, HEAD).at(-1)).toEqual({ name: 'G3', ok: false, says: 'open' })
})

test('D3 greptileFacts with no score and no findings file', () => {
  const { db, dir, plan } = greptiled({})
  expect(greptileFacts(db, dir, plan, HEAD)).toEqual([
    { name: 'greptile', ok: false, says: 'no score' },
    { name: 'findings', ok: true, says: '0 findings' },
  ])
})

const PLAN = 1
const NOW = new Date('2026-10-08T00:00:00Z')
const DAY = 86400000
const PROFILE = 'disclosure: >-\n  Built with an AI agent\n  and reviewed by a person.\nintake: { pace: { prs: 1, days: 7 } }\n'
const DISCLOSURE = 'Built with an AI\nagent and reviewed by a person.'
const ISSUE: Issue = { number: 12, title: 't', body: '', state: 'OPEN', assignees: [{ login: OPERATOR }], comments: [],
  closedByPullRequestsReferences: [] }
const signedOff = (subject: string): string => `${subject}\n\nSigned-off-by: t <t@t>`

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' })
}

function rooted(profile: string | null, files: Record<string, string> = {}, ours = signedOff('add hello')): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-rules-'))
  if (profile !== null) {
    mkdirSync(join(root, 'profiles/acme'), { recursive: true })
    writeFileSync(join(root, 'profiles/acme/widget.yml'), profile)
  }
  const src = srcDir(root, PLAN)
  git(src, ['init', '-q', '-b', 'main'])
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(src, name)), { recursive: true })
    writeFileSync(join(src, name), text)
  }
  git(src, ['add', '-A'])
  git(src, ['commit', '-q', '--allow-empty', '-m', signedOff('a')])
  git(src, ['update-ref', MAIN, 'HEAD'])
  git(src, ['commit', '-q', '--allow-empty', '-m', ours])
  return root
}

function opened(days: number[], sent: string[][] = []): Read {
  return (args) => {
    sent.push(args)
    return days.map((ago) => ({ createdAt: new Date(NOW.getTime() - ago * DAY).toISOString() }))
  }
}

function rule(root: string, name: string, body: string, read = opened([]), row = ISSUE): Fact | undefined {
  return ruleFacts(root, PLAN, 'acme/widget', row, body, read, NOW).find((f) => f.name === name)
}

test('D1 a missing disclosure is no, a reflowed one present', () => {
  const root = rooted(PROFILE)
  expect(rule(root, 'disclosure', 'Closes #12')).toEqual({ name: 'disclosure', ok: false, says: 'missing' })
  expect(rule(root, 'disclosure', `Closes #12\n\n${DISCLOSURE}\n`)).toEqual({ name: 'disclosure', ok: true, says: 'present' })
})

test('D2 the pace cap reached is no, older PRs do not count', () => {
  const root = rooted(PROFILE)
  expect(rule(root, 'pace', '', opened([1]))).toEqual({ name: 'pace', ok: false,
    says: 'pace: 1 opened in acme/widget in the last 7 days, cap 1' })
  expect(rule(root, 'pace', '', opened([8]))).toEqual({ name: 'pace', ok: true, says: 'under 1 in 7 days' })
})

test('D3 a template section missing from the body is named', () => {
  const root = rooted(null, { '.github/PULL_REQUEST_TEMPLATE.md': '## Linked issue\n\nsay which\n\n## Testing\n' })
  expect(rule(root, 'template', '## Linked issue\n\nCloses #12\n'))
    .toEqual({ name: 'template', ok: false, says: 'missing ## Testing' })
})

test('D4 an unlinked body and an unassigned issue are no', () => {
  const root = rooted(null)
  expect(rule(root, 'linked', 'Closes #123')).toEqual({ name: 'linked', ok: false, says: '#12 not in the body' })
  expect(rule(root, 'assigned', 'Closes #12', opened([]), { ...ISSUE, assignees: [] }))
    .toEqual({ name: 'assigned', ok: false, says: 'assigned to nobody' })
})

test('D5 our unsigned commit in a signing repo is named', () => {
  const root = rooted(null, {}, 'add hello')
  expect(rule(root, 'signed', '')).toEqual({ name: 'signed', ok: false, says: '"add hello" has no Signed-off-by' })
})

test('D6 no profile passes disclosure and pace with no gh call', () => {
  const sent: string[][] = []
  expect(ruleFacts(rooted(null), PLAN, 'acme/widget', ISSUE, 'Closes #12', opened([1], sent), NOW)).toEqual([
    { name: 'template', ok: true, says: 'no template' },
    { name: 'disclosure', ok: true, says: 'no disclosure rule' },
    { name: 'linked', ok: true, says: '#12 linked' },
    { name: 'assigned', ok: true, says: 'assigned to us' },
    { name: 'signed', ok: true, says: 'no Signed-off-by missing' },
    { name: 'pace', ok: true, says: 'no pace rule' },
  ])
  expect(sent).toEqual([])
})
