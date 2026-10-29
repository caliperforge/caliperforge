import { expect, test } from 'vitest'
import { gates } from '../../store/approvals.ts'
import { pushedRow } from '../../store/deliverables.ts'
import { ofKind } from '../../store/events.ts'
import { record } from '../../store/files.ts'
import { amend, lanes } from '../../store/lanes.ts'
import { dropPlan, pipeOf, planRows } from '../../store/plans.ts'
import { fingerprint, refused } from '../../store/refusals.ts'
import { at } from '../../templates/pr-path.ts'
import { greenSince } from '../base.ts'
import { tick } from '../index.ts'
import { fingerprintOf } from '../refusal.ts'
import { CI_ONLY } from '../settle.ts'
import { get } from '../workspace.ts'
import { CARRIED, internalPlan, ours, REFUSE, stub, watched, world } from './world.ts'

const text = (note: string) => ({ outcome: 'refuse' as const, spans: ['text:5 identifier.unresolved'], note })
const base = (note: string) => ({ outcome: 'refuse' as const, spans: ['base:stale'], note })

test('text spans differ by what they name', () => {
  expect(fingerprintOf(at(3), text('identifiers: cli/extra.ts'))).not.toBe(fingerprintOf(at(3), text('identifiers: schema/0036_x.sql')))
  expect(fingerprintOf(at(3), text('identifiers: cli/extra.ts'))).toBe(fingerprintOf(at(3), text('identifiers: cli/extra.ts')))
})

test('D1 identifiers notes naming a .sh and a .sql file differ', () => {
  const said = (name: string) => text(`identifiers: 1 identifier(s) name no source in the tree: ${name}`)
  expect(fingerprintOf(at(3), said('scripts/vendor_machine_schema.sh'))).not.toBe(fingerprintOf(at(3), said('schema/0049_target_take.sql')))
})

const fence = (why: string) => ({ outcome: 'refuse' as const, spans: ['researcher.fence'], note: `researcher reply has no valid sources fence: ${why}` })

test('D1 fence refusals differ by the fault they name', () => {
  expect(fingerprintOf(at(1), fence('the reply does not close with `---`'))).not.toBe(fingerprintOf(at(1), fence('line 5: claim')))
})

test('D2 one fence fault twice fingerprints the same', () => {
  expect(fingerprintOf(at(1), fence('line 5: claim'))).toBe(fingerprintOf(at(1), fence('line 5: claim')))
})

test('D3 other spans still match on the span alone', () => {
  expect(fingerprintOf(at(6), base('behind main'))).toBe(fingerprintOf(at(6), base('behind main again')))
})

const research = (span: string, note: string) => ({ outcome: 'refuse' as const, spans: [span], note })

test('D1 unsourced refusals differ by the sentence named', () => {
  const a = fingerprintOf(at(2), research('research.unsourced', 'no source for line 3: Rust is fast'))
  expect(a).not.toBe(fingerprintOf(at(2), research('research.unsourced', 'no source for line 7: Go is old')))
})

test('D2 one unsourced note twice is again then repeat', () => {
  const w = world()
  const unsourced = research('research.unsourced', 'no source for line 3: Rust is fast')
  const print = fingerprintOf(at(2), unsourced)
  expect(print).toBe(fingerprintOf(at(2), unsourced))
  expect(refused(w.db, { plan: 1, step: 2, fingerprint: print, diff: null })).toBe('again')
  expect(refused(w.db, { plan: 1, step: 2, fingerprint: print, diff: null })).toBe('repeat')
})

test('D3 research URL and quote faults differ by what they name', () => {
  for (const [span, say] of [['research.quote_missing', 'quote not on the page for '], ['research.dead_source', 'dead source: '],
    ['researcher.unquoted', 'no quote for ']] as const) {
    expect(fingerprintOf(at(2), research(span, `${say}https://a.example`))).not.toBe(fingerprintOf(at(2), research(span, `${say}https://b.example`)))
  }
})

test('D2 a shared refusal stops its lane and names plans and span', async () => {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, 2)
  internalPlan(w.db, w.root, 3, 'an earlier plan', 35)
  amend(w.db, 3, { state: 'done' })
  for (let step = 0; step < 4; step += 1) await tick(w.db, w.root, stub(CARRIED))
  refused(w.db, { plan: 3, step: 4, fingerprint: fingerprint(4, ['src/hello.ts:1']), diff: null, base: get(w.root, 2, 'base.sha').trim() })
  internalPlan(w.db, w.root, 4, 'a later plan', 36)
  amend(w.db, 4, { state: 'running', step: 2 })
  record(w.db, 4, [{ path: 'src/hello.ts', is_new: false }])
  const fired = await tick(w.db, w.root, stub(CARRIED, 0, REFUSE))
  expect(fired.map((f) => f.plan)).toEqual([2])
  expect(fired[0]?.note).toContain('lane off: plans 2 and 3 refused on src/hello.ts:1')
  expect(pipeOf(w.db, 1).enabled).toBe(0)
  expect(ofKind(w.db, 'pipe').map((e) => [e.actor, e.outcome])).toEqual([['settle', 'escalate']])
  expect(planRows(w.db).find((p) => p.id === 4)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo',
    held_why: expect.stringMatching(/^lane off: plans 2 and 3 refused on src\/hello\.ts:1/) as unknown })
  expect(lanes(w.db, '09:00').live).toBe(0)
})

test('D7 another sha with a green main since leaves the lane on', async () => {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, 2)
  internalPlan(w.db, w.root, 3, 'an earlier plan', 35)
  amend(w.db, 3, { state: 'done' })
  for (let step = 0; step < 4; step += 1) await tick(w.db, w.root, stub(CARRIED))
  refused(w.db, { plan: 3, step: 4, fingerprint: fingerprint(4, ['src/hello.ts:1']), diff: null, base: 'f'.repeat(40) })
  const asked: string[][] = []
  const green = watched([], w.root, 2, (args) => { asked.push(args); return JSON.stringify([{ conclusion: 'success', createdAt: new Date().toISOString() }]) })
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, REFUSE), undefined, undefined, green))[0]
  expect(fired).toMatchObject({ plan: 2, step: 4, outcome: 'refuse' })
  expect(asked.filter((a) => a.includes('--branch') && a.includes('main'))).toHaveLength(1)
  expect(fired?.note).not.toContain('lane off')
  expect(pipeOf(w.db, 1).enabled).toBe(1)
})

test('D6 greenSince counts only a main success after since', () => {
  const on = (conclusion: string, createdAt: string): boolean =>
    greenSince(() => JSON.stringify([{ conclusion, createdAt }]))('caliperforge/caliperforge', '2026-10-29T12:00:00Z')
  expect(on('success', '2026-10-29T12:00:01Z')).toBe(true)
  expect(on('failure', '2026-10-29T12:00:01Z')).toBe(false)
  expect(on('success', '2026-10-29T11:59:59Z')).toBe(false)
})

test('D1 a refusal from a plan that landed leaves the lane on', async () => {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, 2)
  internalPlan(w.db, w.root, 3, 'an earlier plan', 35)
  amend(w.db, 3, { state: 'done' })
  refused(w.db, { plan: 3, step: 4, fingerprint: fingerprint(4, ['src/hello.ts:1']), diff: null })
  for (let step = 0; step < 4; step += 1) await tick(w.db, w.root, stub(CARRIED))
  pushedRow(w.db, { plan: 3, step: 6, seat: 'typescript_specialist', diff_digest: 'd'.repeat(64),
    evidence: 'https://github.com/caliperforge/caliperforge/pull/1' }, gates(w.db, 3, 'd'.repeat(64)))
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, REFUSE)))[0]
  expect(fired?.note).not.toContain('lane off')
  expect(pipeOf(w.db, 1).enabled).toBe(1)
})

test('CI state never switches a lane off', () => {
  expect(['checks:CI', 'https://x/runs/1 ci.red', 'u ci.pending'].every((s) => CI_ONLY.test(s))).toBe(true)
  expect(['src/hello.ts:1', 'base:stale', 'text:5 identifier.unresolved'].some((s) => CI_ONLY.test(s))).toBe(false)
})
