import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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

test('D5 a director return opens the path rulings.md names', async () => {
  const { db, home } = seeded(3)
  put(home, 7, 'rulings.md', 'the builder edits `index.ts`\n')
  await woke(db, home, stub('', '---\nmove: return\nwhy: the ruling names the file\n---\n'), now, () => undefined, wire)
  expect(filesOf(db, 7)).toEqual([{ path: 'index.ts', is_new: true }])
  expect(eventsOf(db, 7, 'files')).toEqual([{ actor: 'ruling', outcome: 'pass', message: 'add index.ts: named in rulings.md' }])
})
