import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { holdOf } from '../../store/holds.ts'
import { advance, dropPlan } from '../../store/plans.ts'
import { shape, type Refused } from '../brief.ts'
import { tick } from '../index.ts'
import { maybe } from '../workspace.ts'
import { git, GREEN, pkg } from './bases.ts'
import { approve, CARRIED, internalPlan, ours, plan, stub, world, type World } from './world.ts'

const repo = join(import.meta.dirname, '../..')

const fixture = (name: string): string => readFileSync(join(repo, 'seats/brief_writer/tests', name), 'utf8')

const ask = fixture('ask.md')

const brief = fixture('brief.md')

const carrying = (rows: string[], text = brief): string =>
  text.replace('\n## Cases', `\n## Reproduced\n\n${rows.join('\n')}\n\n## Cases`)

const outside = (text: string): Refused | null => shape(text, ask, repo, true)

const TS = '- command: `npm run test -- sequencer/tests/brief.test.ts`'

test('D1 no ## Reproduced, or no single command row, is refused', () => {
  expect(outside(brief)).toMatchObject({ span: '## Reproduced' })
  expect(outside(carrying(['- expect: fails']))).toMatchObject({ span: '## Reproduced', reason: expect.stringContaining('command') as string })
  expect(outside(carrying([TS, '- command: `npm run lint`', '- expect: fails']))).toMatchObject({ span: '## Reproduced' })
})

test('D2 no single fails or shows expect row is refused', () => {
  const refused = { span: '## Reproduced', reason: expect.stringContaining('expect') as string }
  expect(outside(carrying([TS]))).toMatchObject(refused)
  expect(outside(carrying([TS, '- expect: maybe']))).toMatchObject(refused)
  expect(outside(carrying([TS, '- expect: fails', '- expect: shows']))).toMatchObject(refused)
})

test('D3 a command no builder admits is the span, naming seats', () => {
  expect(outside(carrying(['- command: `npx vitest run`', '- expect: fails'])))
    .toEqual({ span: 'npx vitest run', reason: 'npx vitest run is on the Bash(...) list of none of typescript_specialist' })
  expect(outside(carrying(['- command: `npm run test; rm x`', '- expect: shows'])))
    .toMatchObject({ span: 'npm run test; rm x', reason: expect.stringContaining('typescript_specialist') as string })
})

test('D3 a docs-only brief falls to outside_specialist, refused', () => {
  const docs = brief.replace(/## Files\n\n[^#]*/, '## Files\n\n- seats/brief_writer/prompt.md\n\n')
  expect(outside(carrying(['- command: `npm run test`', '- expect: fails'], docs)))
    .toMatchObject({ span: 'npm run test', reason: expect.stringContaining('outside_specialist') as string })
})

test('D4 a command the files\' builder admits passes', () => {
  expect(outside(carrying([TS, '- expect: fails', '- output: ignored']))).toBeNull()
  const kotlin = brief.replace(/## Files\n\n[^#]*/, '## Files\n\n- kotlin/build.gradle.kts (new)\n\n')
  expect(outside(carrying(['- command: `./gradlew test`', '- expect: shows'], kotlin))).toBeNull()
})

test('D5 a caliperforge brief passes with no ## Reproduced', () => {
  expect(shape(brief, ask, repo)).toBeNull()
})

const COMMANDED = '`npm run test -- src/hello.ts`'

/** An outside world whose upstream moved on: a commit adding a `test` script that prints `line` and exits `code`. */
function moved(line: string, code: number): World {
  const w = world()
  approve(w.db, w.target)
  const upstream = join(w.root, 'remotes/acme/widget')
  writeFileSync(join(upstream, 'package.json'), pkg({ test: `node -e "console.log('${line}'); process.exit(${String(code)})"` }))
  git(upstream, ['add', '-A'])
  git(upstream, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'they change it'])
  return w
}

/** Step 0, then step 1 answered with the stub's brief edited by `edit`; the reply and step 1's fire. */
async function briefing(w: World, edit = (b: string): string => b): Promise<{ reply: string; fired: unknown }> {
  await tick(w.db, w.root, stub(CARRIED))
  const inner = stub(CARRIED)
  let reply = ''
  const fired = (await tick(w.db, w.root, { ...inner, fire: async (packet) => {
    const done = await inner.fire(packet)
    if (!packet.prompt.includes('# brief_writer')) return done
    reply = edit(done.text)
    return { ...done, text: reply }
  } }))[0]
  return { reply, fired }
}

const baseOf = (w: World): string => maybe(w.root, w.plan, 'base.sha')?.trim() ?? ''

test('run D1 issue.md carries the base, the exit and the output', async () => {
  const w = moved('still broken', 1)
  const { fired } = await briefing(w)
  expect(fired).toMatchObject({ step: 1, outcome: 'pass' })
  expect(maybe(w.root, w.plan, 'issue.md')).toContain(`- expect: fails\n- base: \`${baseOf(w)}\`\n- exit: 1\n> `)
  expect(maybe(w.root, w.plan, 'issue.md')).toContain('\n> still broken\n')
  expect(plan(w.db, w.plan).step).toBe(2)
})

test('run D2 a fails that exits 0 stops step 1 as already fixed', async () => {
  const w = moved('already works', 0)
  const { fired } = await briefing(w)
  expect(fired).toMatchObject({ step: 1, outcome: 'needs_ceo', spans: ['already fixed'] })
  expect(maybe(w.root, w.plan, 'issue.md')).toBeNull()
  expect(holdOf(w.db, w.plan)?.held_why).toContain(`brief_writer: already fixed at ${baseOf(w)}: ${COMMANDED} exited 0 > `)
  expect(holdOf(w.db, w.plan)?.held_why).toContain(' > already works')
})

test('run D3 a shows that exits 0 saves the brief', async () => {
  const w = moved('it shows', 0)
  const { fired } = await briefing(w, (b) => b.replace('- expect: fails', '- expect: shows'))
  expect(fired).toMatchObject({ step: 1, outcome: 'pass' })
  expect(maybe(w.root, w.plan, 'issue.md')).toContain(`- expect: shows\n- base: \`${baseOf(w)}\`\n- exit: 0\n`)
  expect(plan(w.db, w.plan).step).toBe(2)
})

test('run D4 a caliperforge plan runs nothing', async () => {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root, GREEN)
  internalPlan(w.db, w.root, 2)
  const { reply, fired } = await briefing(w)
  expect(fired).toMatchObject({ step: 1, outcome: 'pass' })
  expect(maybe(w.root, 2, 'issue.md')).toBe(reply)
})

test('run D5 a command reproduced() refuses never runs', async () => {
  const w = world()
  approve(w.db, w.target)
  const touch = `touch ${join(w.root, 'ran')}`
  const { reply, fired } = await briefing(w, (b) => b.replace(COMMANDED, `\`${touch}\``))
  expect(fired).toMatchObject({ step: 1, outcome: 'refuse', spans: [touch],
    note: `brief_writer: ${touch} is on the Bash(...) list of none of typescript_specialist` })
  expect(existsSync(join(w.root, 'ran'))).toBe(false)
  expect(maybe(w.root, w.plan, 'brief.refused.md')).toBe(reply)
})

test('run D6 a brief carrying the run stands at a later tick', async () => {
  const w = moved('you must run npm ci first', 1)
  await briefing(w)
  const saved = maybe(w.root, w.plan, 'issue.md')
  advance(w.db, plan(w.db, w.plan), 1)
  expect((await tick(w.db, w.root, stub(CARRIED)))[0]).toMatchObject({ step: 1, outcome: 'pass', note: 'the brief stands' })
  expect(maybe(w.root, w.plan, 'issue.md')).toBe(saved)
})
