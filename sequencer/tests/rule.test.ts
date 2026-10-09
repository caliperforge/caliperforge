import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { eventsOf } from '../../store/events.ts'
import { filesOf, recorded, strays } from '../../store/files.ts'
import { migrate, open } from '../../store/index.ts'
import { planById } from '../../store/plans.ts'
import type { Wire } from '../push.ts'
import { woke } from '../director.ts'
import { fenced, opened, owned } from '../rule.ts'
import { maybe, put, srcDir } from '../workspace.ts'

const repo = join(import.meta.dirname, '../..')
const now = new Date('2026-09-28T17:00:00.000Z')
const FIX = '---\nmove: fix\nwhy: the builder asked which helper to call\n---\n'
const ISSUE = '# hello\n\n**What:** add it.\n**Why:** asked.\n\n## Out of scope\n\n- the rest\n\n## Standing\n\n- no forced push\n'

function seeded(step: number) {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec(readFileSync(join(repo, 'runner/tests/fixtures/waiting.sql'), 'utf8'))
  db.prepare("UPDATE plans SET state = 'blocked_on_ceo', wait_reason = NULL, step = ? WHERE id = 7").run(step)
  if (step === 1) db.exec('UPDATE runs SET step = 1 WHERE plan = 7')
  db.exec(`INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at) VALUES
    ('director.apply', '1', 'ceo', 'ruling', 't', '2026-09-28'), ('fixer.mode', 'live', 'ceo', 'ruling', 't', '2026-09-28')`)
  const home = mkdtempSync(join(tmpdir(), 'cf-rule-'))
  for (const dir of ['rules', 'seats']) cpSync(join(repo, dir), join(home, dir), { recursive: true })
  put(home, 7, 'ask.md', 'the ask\n')
  put(home, 7, 'issue.md', ISSUE)
  put(home, 7, 'question.md', 'which helper do I call?\n')
  put(home, 7, 'step-4.verdict.md', '---\noutcome: refuse\nspans:\n  - x\n---\n')
  put(home, 7, 'base.sha', `${'a'.repeat(40)}\n`)
  writeFileSync(join(srcDir(home, 7), 'index.ts'), 'export {}\n')
  mkdirSync(join(srcDir(home, 7), '.git'))
  return { db, home }
}

function stub(fix: string, said = FIX): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (packet) => Promise.resolve({ text: basename(packet.transcript).startsWith('fixer') ? fix : said,
      transcript_path: packet.transcript, usage: { input: 10, cache: 0, output: 5 },
      seconds: 0, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 }),
  }
}

const no = (): never => { throw new Error('not in this test') }
const wire: Wire = { send: no, open: no, close: no, runs: no, comment: no, review: no, merged: no, file: no }

const answered = (answer: string, then = 'return') => `---\ndid: nothing\nthen: ${then}\nwhy: the checkout answers it\nanswer: ${answer}\n---\n`

async function fixed(step: number, fix: string) {
  const { db, home } = seeded(step)
  const posted: string[] = []
  await woke(db, home, stub(fix), now, (t) => void posted.push(t), wire)
  const state = db.prepare('SELECT state, step FROM plans WHERE id = 7').get()
  const applied = db.prepare('SELECT applied FROM decisions').all()
  return { state, applied, posted, ask: maybe(home, 7, 'ask.md'), issue: maybe(home, 7, 'issue.md') }
}

test('D1 before a build the answer goes on ask.md, back to step 1', async () => {
  const got = await fixed(1, answered('call `bye()` from src/bye.ts'))
  expect(got.ask).toMatch(/^the ask\n\n## Answer from the fixer \(\d{4}-\d{2}-\d{2}\)\n\ncall `bye\(\)` from src\/bye.ts\n$/)
  expect(got.issue).toBe(ISSUE)
  expect(got.state).toEqual({ state: 'queued', step: 1 })
})

test('D2 after a build the answer sits above ## Standing; rebuilds', async () => {
  const got = await fixed(3, answered('call `bye()`'))
  expect(got.issue).toMatch(/\n- the rest\n\n## Answer from the fixer \(\d{4}-\d{2}-\d{2}\)\n\ncall `bye\(\)`\n\n## Standing\n\n- no forced push\n$/)
  expect(got.issue?.startsWith('# hello\n\n**What:** add it.\n**Why:** asked.\n')).toBe(true)
  expect(got.ask).toBe('the ask\n')
  expect(got.state).toMatchObject({ step: 2 })
})

test('D3 an answer naming .cf/work/ is refused and escalates', async () => {
  const got = await fixed(3, answered('see .cf/work/354/ask.md'))
  expect(got.ask).toBe('the ask\n')
  expect(got.issue).toBe(ISSUE)
  expect(got.state).toEqual({ state: 'blocked_on_ceo', step: 3 })
  expect(got.applied).toEqual([{ applied: 'escalated' }])
  expect(got.posted).toEqual(['CaliperForge · #139 needs you'])
})

test('an absolute path outside the root is refused', async () => {
  const got = await fixed(1, answered('the key is in ~/secrets and (/etc/hosts)'))
  expect(got.ask).toBe('the ask\n')
  expect(got.applied).toEqual([{ applied: 'escalated' }])
})

test('D1 quoted code starting with / is written', async () => {
  const got = await fixed(3, answered('remove `/** a comment */` and `// note`'))
  expect(got.issue).toContain('\n\nremove `/** a comment */` and `// note`\n\n## Standing\n')
  expect(got.applied).toEqual([{ applied: 'applied' }])
})

test('D2 an absolute path elsewhere is refused', async () => {
  const got = await fixed(1, answered('see /Users/x/elsewhere/file.ts'))
  expect(got.ask).toBe('the ask\n')
  expect(got.issue).toBe(ISSUE)
  expect(got.applied).toEqual([{ applied: 'escalated' }])
})

test('an answer holding only a URL is written', async () => {
  const got = await fixed(1, answered('https://github.com/caliperforge/caliperforge/issues/139'))
  expect(got.ask).toContain('\n\nhttps://github.com/caliperforge/caliperforge/issues/139\n')
  expect(got.applied).toEqual([{ applied: 'applied' }])
})

test('D4 a reply with no answer writes nothing; the plan returns', async () => {
  const got = await fixed(3, '---\ndid: nothing\nthen: return\nwhy: the question is answered\n---\n')
  expect(got.ask).toBe('the ask\n')
  expect(got.issue).toBe(ISSUE)
  expect(got.state).toEqual({ state: 'queued', step: 3 })
})

test('an elided path is written', async () => {
  const got = await fixed(1, answered('the parser in kotlin/.../core/Headers.kt decodes it'))
  expect(got.applied).toEqual([{ applied: 'applied' }])
})

test('its own plan folder is written', async () => {
  const got = await fixed(1, answered('see .cf/work/7/question.md'))
  expect(got.applied).toEqual([{ applied: 'applied' }])
})

test('a parent path is refused', async () => {
  const got = await fixed(1, answered('see ../other/repo'))
  expect(got.applied).toEqual([{ applied: 'escalated' }])
})

const SPANS = 'step 3 rails refused by rails\n\nauthority: 3 span(s)\n\nspans:\n  - cli/extra.ts:1 authority.outside_files\n'
  + '  - schema/0001_x.sql:1 authority.frozen_schema\n  - src/far.ts:1 authority.write_paths\n'

test('D5 only a named outside_files path gets a row', () => {
  const { db, home } = seeded(3)
  put(home, 7, 'refusal.md', SPANS)
  const plan = planById(db, 7)
  expect(owned(home, plan, 'schema/0001_x.sql and src/far.ts')).toBe(false)
  expect(maybe(home, 7, 'issue.md')).toBe(ISSUE)
  expect(owned(home, plan, 'cli/extra.ts\nholds   it')).toBe(true)
  const row = '- `cli/extra.ts` — cli/extra.ts holds it\n'
  expect(maybe(home, 7, 'issue.md')).toBe(ISSUE.replace('## Standing', `## Outside the files\n\n${row}\n## Standing`))
  const once = maybe(home, 7, 'issue.md')
  expect(owned(home, plan, 'nothing refused is named')).toBe(false)
  expect(maybe(home, 7, 'issue.md')).toBe(once)
  expect(owned(home, plan, 'cli/extra.ts again')).toBe(true)
  expect(maybe(home, 7, 'issue.md')).toContain(`${row}- \`cli/extra.ts\` — cli/extra.ts again\n\n## Standing`)
})

test('a path is named only as a whole word', () => {
  const { db, home } = seeded(3)
  put(home, 7, 'refusal.md', SPANS.replace('cli/extra.ts', 'extra.ts'))
  expect(owned(home, planById(db, 7), 'cli/extra.ts holds it')).toBe(false)
  expect(owned(home, planById(db, 7), 'extra.ts holds it.')).toBe(true)
})

test('a step-4 stop on an old step-3 refusal is not fenced', () => {
  const { db, home } = seeded(4)
  put(home, 7, 'refusal.md', `${SPANS}\n# Stopped\n\nspent 9.0M tokens.\n`)
  expect(fenced(home, planById(db, 7))).toBe(false)
  expect(owned(home, planById(db, 7), 'cli/extra.ts holds it')).toBe(false)
  expect(maybe(home, 7, 'issue.md')).toBe(ISSUE)
})

test('D4 opened lists a stray row by clearing its flag', () => {
  const { db, home } = seeded(3)
  strays(db, 7, ['index.ts'])
  put(home, 7, 'rulings.md', 'see `index.ts`\n')
  expect(opened(db, home, 7)).toEqual([])
  expect(recorded(db, 7)).toEqual(['index.ts'])
  expect(filesOf(db, 7)).toEqual([{ path: 'index.ts', is_new: false }])
})

const ROUND_6 = ['**Ruling (CEO, 2026-10-05, round 6, pre-upstream):** Two small changes before this goes upstream.',
  '- `harness/kotlin-protocol-runner/src/main/kotlin/com/solana/paykit/protocolrunner/Main.kt`: add a 3-line header comment ... per the contract in `harness/src/protocol/runners/spawn.ts`. No other comments.']
const ROUND_9 = ['**Ruling (COO, 2026-10-06, round 9):** ... against a version `typescript/pnpm-lock.yaml` already pins on main.',
  '- Audit is ruled unrelated to this card. It must not send this job back as `ci_red`, and no builder touches `typescript/`, the lockfile or the audit shim.']
const RULINGS = [...ROUND_6, ...ROUND_9,
  '**Ruling (COO, 2026-10-07, round 10, Greptile on caliperforge/pay-kit#21 at 85236297):** Both P1 findings are overruled.',
  '- G4192451832 (opaque is decoded): the reference contract decodes `opaque` as base64url JSON (`go/cmd/protocol-runner/main.go:93` and `:142-146`)',
  '- G4192451856 ...: `harness/runners/kotlin.json` on main (from #179) calls the same prebuilt `build/install/...` binary',
  '**Ruling (COO, 2026-10-08):** The step-6 hold is the machine, not this job. #989 (2257679) makes the ready gate recompute bot_clean from current rulings, but the tick only lets step 6 run when the deliverable row already says bot_clean=1, and senior saved 0 before the round-10 ruling. Back to step 5 so senior writes a fresh deliverable under rounds 9 and 10; no code change, no builder run. A ticket fixes the pre-check so this does not recur.',
].join('\n')

function cited() {
  const { db, home } = seeded(3)
  for (const path of ['typescript/pnpm-lock.yaml', 'go/cmd/protocol-runner/main.go', 'harness/runners/kotlin.json', 'harness/src/protocol/runners/spawn.ts']) {
    mkdirSync(dirname(join(srcDir(home, 7), path)), { recursive: true })
    writeFileSync(join(srcDir(home, 7), path), '\n')
  }
  return { db, home }
}

test('D1 opened adds no path an older round cites', () => {
  const { db, home } = cited()
  put(home, 7, 'rulings.md', RULINGS)
  expect(opened(db, home, 7)).toEqual([])
  expect(filesOf(db, 7)).toEqual([])
})

test('D2 a line saying no builder touches it opens none', () => {
  const { db, home } = cited()
  put(home, 7, 'rulings.md', [...ROUND_6, ...ROUND_9].join('\n'))
  expect(opened(db, home, 7)).toEqual([])
  expect(filesOf(db, 7)).toEqual([{ path: 'typescript/pnpm-lock.yaml', is_new: true }])
})

test('D3 D4 the newest ruling adds its path, an older one not', () => {
  const { db, home } = seeded(3)
  mkdirSync(join(srcDir(home, 7), 'src'))
  writeFileSync(join(srcDir(home, 7), 'src/x.ts'), 'export {}\n')
  put(home, 7, 'rulings.md', '**Ruling (COO, 2026-10-07):** the builder edits `index.ts`.\n**Ruling (COO, 2026-10-08):** add `src/x.ts`.\n')
  expect(opened(db, home, 7)).toEqual([])
  expect(filesOf(db, 7)).toEqual([{ path: 'src/x.ts', is_new: true }])
})

test('D1 D3 plan files and placeholders are not refused', () => {
  const { db, home } = seeded(3)
  put(home, 7, 'step-2.handback.md', 'handed back\n')
  mkdirSync(join(srcDir(home, 7), 'src'))
  writeFileSync(join(srcDir(home, 7), 'src/x.ts'), 'export {}\n')
  put(home, 7, 'rulings.md', 'see `step-2.handback.md:9`, `store/<file>` and `src/x.ts`\n')
  expect(opened(db, home, 7)).toEqual([])
  expect(filesOf(db, 7)).toEqual([{ path: 'src/x.ts', is_new: true }])
  expect(eventsOf(db, 7, 'files')).toEqual([{ actor: 'ruling', outcome: 'pass', message: 'add src/x.ts: named in rulings.md' }])
})

test('D2 a path in neither folder is refused', () => {
  const { db, home } = seeded(3)
  put(home, 7, 'rulings.md', 'see `src/gone.ts`\n')
  expect(opened(db, home, 7)).toEqual(['src/gone.ts'])
  expect(eventsOf(db, 7, 'files')).toEqual([{ actor: 'ruling', outcome: 'refuse', message: 'not in the checkout: src/gone.ts' }])
})

test('D5 a director return opens the path rulings.md names', async () => {
  const { db, home } = seeded(3)
  put(home, 7, 'rulings.md', 'the builder edits `index.ts`\n')
  await woke(db, home, stub('', '---\nmove: return\nwhy: the ruling names the file\n---\n'), now, () => undefined, wire)
  expect(filesOf(db, 7)).toEqual([{ path: 'index.ts', is_new: true }])
  expect(eventsOf(db, 7, 'files')).toEqual([{ actor: 'ruling', outcome: 'pass', message: 'add index.ts: named in rulings.md' }])
})
