import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet, Provider } from '../../providers/kind.ts'
import { landed } from '../../cli/batch.ts'
import { check } from '../../cli/digests.ts'
import { digest, listed } from '../../runner/rules.ts'
import { gates, gatesSigned, headApproved, headDigest, signedHead } from '../../store/approvals.ts'
import { approved, deliverablesOf } from '../../store/deliverables.ts'
import { record as recordFiles } from '../../store/files.ts'
import { runRows } from '../../store/events.ts'
import { width } from '../../store/lanes.ts'
import { advance, dropPlan } from '../../store/plans.ts'
import { verdictRows } from '../../store/verdict.ts'
import { tick } from '../index.ts'
import { headOf, push } from '../push.ts'
import { blocked } from '../steps.ts'
import { get, internalBranch, SELF, srcDir } from '../workspace.ts'
import { approve, CARRIED, internalPlan, landing, ours, owning, plan, runsAll, runsOn, slow, stub, watched, world, type World } from './world.ts'

const ID = 2
const SECOND = 3
const NAP = 500
const ISSUE = 'https://github.com/caliperforge/caliperforge/issues/34'

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** The pr-path world with its target plan taken out, so the one lane carries our own issue alone. */
function mine(): World {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  return w
}

/** Two of our own issues in the one lane, with the cap open for both. */
function pair(): World {
  const w = mine()
  internalPlan(w.db, w.root, SECOND, 'let a second internal plan run', 35)
  width(w.db, 1, 2)
  return w
}

/** Every stub brief names `src/hello.ts`; the second plan is given its own file so the overlap rule lets both build at once. */
function apart(w: World): void {
  recordFiles(w.db, SECOND, [{ path: `src/p${String(SECOND)}.ts`, is_new: true }])
}

test('two picks fire at once, each with its own run row',async () => {
  const w = pair()
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  apart(w)

  const provider = slow(NAP, CARRIED)
  const fired = await tick(w.db, w.root, provider)
  expect(provider.peak()).toBe(2)
  expect(fired.map((f) => f.plan)).toEqual([ID, SECOND])
  expect([plan(w.db, ID).state, plan(w.db, SECOND).state]).toEqual(['running', 'running'])
  expect(runRows(w.db).filter((r) => r.step === 2).map(({ plan, seat }) => ({ plan, seat })).sort((a, b) => a.plan - b.plan))
    .toEqual([{ plan: ID, seat: 'typescript_specialist' }, { plan: SECOND, seat: 'typescript_specialist' }])
})

test('two at batch: the first lands, the second goes again',async () => {
  const w = pair()
  const sent: string[] = []
  const wire = landing(watched(sent, w.root, ID, runsAll(w.root, [ID, SECOND])))
  const ownFile = (p: Packet): string => `src/p${/work\/(\d+)\/src/.exec(p.cwd)?.[1] ?? ''}.ts`
  const built: Provider = { name: 'claude-agent-sdk', fire: (p) => stub(owning([ownFile(p)])).fire(p) }
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, built, undefined, undefined, wire)
  apart(w)
  await tick(w.db, w.root, built, undefined, undefined, wire)
  for (const id of [ID, SECOND]) {
    writeFileSync(join(srcDir(w.root, id), `src/p${String(id)}.ts`), `export const p${String(id)} = true\n`)
  }
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, built, undefined, undefined, wire)
  expect([plan(w.db, ID).step, plan(w.db, SECOND).step]).toEqual([7, 7])

  const fired = await tick(w.db, w.root, built, undefined, undefined, wire)
  const remote = join(w.root, 'remotes', SELF)
  expect(fired[1]).toMatchObject({ plan: SECOND, step: 7, spans: ['base:stale'], state: 'running' })
  expect(sent.filter((s) => s === 'send src main')).toEqual(['send src main'])
  expect(git(remote, ['rev-list', '--count', 'main'])).toBe('2')
  expect(git(remote, ['rev-parse', 'main'])).toBe(git(srcDir(w.root, ID), ['rev-parse', 'HEAD']))
  expect([ID, SECOND].filter((id) => deliverablesOf(w.db, id).some((d) => d.state === 'pushed'))).toEqual([ID])
  expect(plan(w.db, SECOND).step).toBe(3)
})

test('origin, no target: measure and ruling pass unapproved',async () => {
  const w = mine()
  expect(blocked(w.db, plan(w.db, ID))).toBeNull()
  const first = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(first).toMatchObject({ plan: ID, step: 0, name: 'measure', outcome: 'pass' })
  expect(first?.note).toContain('caliperforge/caliperforge#34')
  expect(plan(w.db, ID).step).toBe(1)
  expect(blocked(w.db, plan(w.db, ID))).toBeNull()

  const second = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(second).toMatchObject({ step: 1, name: 'ruling', outcome: 'pass' })
  expect(plan(w.db, ID).step).toBe(2)
})

test('our repo on p<plan>-<slug>, built by the typescript seat',async () => {
  const w = mine()
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(fired).toMatchObject({ step: 3, name: 'rails', outcome: 'pass' })
  const src = srcDir(w.root, ID)
  expect(git(src, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('p2-let-an-internal-plan-run')
  expect(git(src, ['remote', 'get-url', 'origin'])).toMatch(/remotes\/caliperforge\/caliperforge$/)
  expect(git(src, ['remote', 'get-url', 'upstream'])).toMatch(/remotes\/caliperforge\/caliperforge$/)
  expect(runRows(w.db).find((r) => r.step === 2)?.seat).toBe('typescript_specialist')
  expect(runRows(w.db).filter((r) => r.step === 1 || r.step === 2).map(({ step, staffed }) => ({ step, staffed })))
    .toEqual([{ step: 1, staffed: 'brief_writer' }, { step: 2, staffed: 'typescript_specialist' }])
  expect(internalBranch(7, 'A/B: an issue — with punctuation!')).toBe('p7-a-b-an-issue-with-punctuation')
  expect(internalBranch(7, '!!!')).toBe('p7-issue')
})

test('D2 our own review packet carries the hand-back', async () => {
  const w = mine()
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const seen: Packet[] = []
  await tick(w.db, w.root, stub(CARRIED, 0, undefined, (p) => seen.push(p)))
  const review = seen.find((p) => p.tools.join() === 'Read')?.prompt ?? ''
  expect(review).toContain(`# The builder's hand-back\n\n${CARRIED}`)
})

test('step 3 fills internal digests; a target has none',async () => {
  const w = mine()
  const built = stub(owning(['seats/brief_writer/prompt.md']))
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, built)
  const src = srcDir(w.root, ID)
  appendFileSync(join(src, 'seats/brief_writer/prompt.md'), '\n')

  const rails = (await tick(w.db, w.root, built))[0]
  expect(rails).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'pass' })
  expect(listed(src).digests.brief_writer?.prompt).toBe(digest(join(src, 'seats/brief_writer/prompt.md')))
  expect(check(src, new Date().toISOString().slice(0, 10))).toEqual([])

  const t = world()
  approve(t.db, t.target)
  for (let at = 0; at < 3; at += 1) await tick(t.db, t.root, stub(CARRIED))
  expect((await tick(t.db, t.root, stub(CARRIED), undefined, undefined, watched([], t.root, t.plan)))[0])
    .toMatchObject({ step: 3, name: 'rails', outcome: 'pass' })
  expect(existsSync(join(srcDir(t.root, t.plan), 'rules'))).toBe(false)
})

test('an unfillable roster refuses one plan; the other steps',async () => {
  const w = pair()
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  apart(w)
  await tick(w.db, w.root, stub(CARRIED))
  writeFileSync(join(srcDir(w.root, ID), 'rules/roster/ghost.yaml'), '')

  const fired = await tick(w.db, w.root, stub(CARRIED))
  expect(fired[0]).toMatchObject({ plan: ID, step: 3, outcome: 'refuse', spans: ['rules/roster'] })
  expect(fired[1]).toMatchObject({ plan: SECOND, step: 3, outcome: 'pass' })
  expect(plan(w.db, ID).step).toBe(2)
})

test('D1 a kernel checkout is filled by its own cli/cf.ts', async () => {
  const w = mine()
  const built = stub(owning(['cli/cf.ts']))
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, built)
  const src = srcDir(w.root, ID)
  mkdirSync(join(src, 'cli'), { recursive: true })
  writeFileSync(join(src, 'cli/cf.ts'), "import { appendFileSync } from 'node:fs'\nappendFileSync('rules.seed.sql', '-- marker\\n')\n")

  expect((await tick(w.db, w.root, built))[0]).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'pass' })
  expect(readFileSync(join(src, 'rules.seed.sql'), 'utf8')).toContain('-- marker\n')
})

test('D2 a cli/cf.ts digests that exits non-zero refuses its plan', async () => {
  const w = mine()
  const built = stub(owning(['cli/cf.ts']))
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, built)
  const src = srcDir(w.root, ID)
  mkdirSync(join(src, 'cli'), { recursive: true })
  writeFileSync(join(src, 'cli/cf.ts'), "process.stderr.write('roster broke\\n')\nprocess.exit(1)\n")

  const rails = (await tick(w.db, w.root, built))[0]
  expect(rails).toMatchObject({ plan: ID, step: 3, outcome: 'refuse', spans: ['rules/roster'], note: 'digests: the checkout could not be filled' })
  expect(get(w.root, ID, 'refusal.md')).toContain('roster broke')
  expect(plan(w.db, ID).step).toBe(2)
})

/** The authority rail reads the same write rule the runner did. */
test('an internal build keeps kernel files outside `src/`',async () => {
  const w = mine()
  const built = stub(owning(['cli/x.ts']))
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, built)
  mkdirSync(join(srcDir(w.root, ID), 'cli'), { recursive: true })
  writeFileSync(join(srcDir(w.root, ID), 'cli/x.ts'), 'export const x = 1\n')

  const rails = (await tick(w.db, w.root, built))[0]
  expect(rails).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'pass' })
  expect(verdictRows(w.db, ID).find((v) => v.rail_id === 'authority')?.outcome).toBe('pass')
})

/** No one outside the machine reads a kernel plan's handback prose. */
test('Tight judges no prose on a kernel plan', async () => {
  const w = mine()
  const told = stub(`Updated \`src/hello.ts\` so hello() says hey.\n\n${CARRIED}`)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, told)
  appendFileSync(join(srcDir(w.root, ID), 'src/hello.ts'), 'export const hey = (): string => "hey"\n')
  expect((await tick(w.db, w.root, told))[0]).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'pass' })
})

test('step 6 sends to origin and judges runs at its head',async () => {
  const w = mine()
  const listed = runsOn(w.root, ID)
  const read: string[] = []
  const sent: string[] = []
  const wire = watched(sent, w.root, ID, (args) => { read.push(args.join(' ')); return listed(args) })
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)

  const fired = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(fired).toMatchObject({ plan: ID, step: 6, name: 'ready', outcome: 'pass' })
  expect(sent).toEqual(['send src p2-let-an-internal-plan-run'])
  expect(read[0]).toContain('--repo caliperforge/caliperforge --branch p2-let-an-internal-plan-run')
  expect(verdictRows(w.db, ID).find((v) => v.rail_id === 'ci-green')?.outcome).toBe('pass')
  expect(plan(w.db, ID).step).toBe(7)
})

test('step 7 signs on the gates and shows a batch read-out',async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  for (let at = 0; at < 7; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(plan(w.db, ID).step).toBe(7)
  expect(blocked(w.db, plan(w.db, ID))).toBeNull()

  const signed = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(signed).toMatchObject({ step: 7, name: 'batch', outcome: 'pass', state: 'running' })
  expect(gatesSigned(w.db)).toBe(1)
  expect(signedHead(w.db, ID, String(plan(w.db, ID).head_digest))).not.toBeNull()
  expect(plan(w.db, ID).step).toBe(8)
  expect(landed(w.db)).toEqual([{ plan: ID, origin: ISSUE, digest: plan(w.db, ID).head_digest }])
  expect(headApproved(w.db, headOf(w.root, ID).sha)).toBe(true)
})

test('gates cannot sign an external plan past ready',async () => {
  const w = world()
  const wire = watched([], w.root, 1)
  approve(w.db, w.target)
  for (let at = 0; at < 7; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(plan(w.db, 1).step).toBe(7)

  const digest = String(plan(w.db, 1).head_digest)
  approved(w.db, 1, gates(w.db, 1, digest))
  expect(() => { advance(w.db, plan(w.db, 1), 8) }).toThrow(/no ceo approval row/)
  expect(headApproved(w.db, headOf(w.root, 1).sha)).toBe(false)
  expect(push(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ outcome: 'refuse' })
  expect(headDigest(headOf(w.root, 1).sha)).toBe(digest)
})
