import { expect, test } from 'vitest'
import { addFinding } from '../../store/drift.ts'
import { logged, runAt } from '../../store/events.ts'
import { addRule } from '../../store/index.ts'
import { ratchetRules } from '../../store/lanes.ts'
import { planById, putPlan } from '../../store/plans.ts'
import { fingerprint, refused } from '../../store/refusals.ts'
import { drift, Entry, recovered } from '../drift.ts'
import { COO, db, event, NOW, REGISTRY } from './drifting.ts'

test('switchOff', () => {
  const d = db()
  const entries = [COO, { name: 'desk', switch: { key: 'comms.site_dir' } }]
  event(d, '2026-10-03 09:00:00')
  d.exec("UPDATE settings SET value = '0' WHERE key = 'director.apply'")
  expect(drift(d, entries, NOW).map((r) => [r.name, r.state])).toEqual([['director', 'off'], ['desk', 'off']])
  d.exec("DELETE FROM settings WHERE key = 'director.apply'")
  expect(drift(d, entries, NOW)[0]).toEqual({ name: 'director', state: 'off', detail: 'director.apply is unset' })
})

test('staleRow', () => {
  const d = db(0)
  expect(drift(d, [COO], NOW)).toEqual([{ name: 'director', state: 'silent', detail: "no row in events WHERE kind = 'director'" }])
  event(d, '2026-09-30 10:00:00')
  expect(drift(d, [COO], NOW).map((r) => r.state)).toEqual(['stale'])
  expect(drift(d, [{ ...COO, gap: undefined }], NOW)).toEqual([])
  expect(drift(d, [{ ...COO, while: 'EXISTS (SELECT 1 FROM pipes WHERE enabled = 1)' }], NOW)).toEqual([])
})

test('fresh', () => {
  const d = db()
  event(d, '2026-10-02 10:00:00')
  expect(drift(d, [COO, { ...COO, name: 'six', gap: '24h' }], NOW)).toEqual([])
  expect(REGISTRY.map((e) => e.name)).toEqual(['director', 'fixer', 'swift_review', 'kotlin_review',
    'python_review', 'ruby_review', 'rust_review', 'go_review', 'php_review', 'typescript_review', 'brief_writer', 'text_review',
    'writer_catchup', 'writer_log', 'writer_ship', 'writer_weekly', 'growth_lead', 'web_specialist', 'design', 'go_specialist', 'php_specialist', 'ruby_specialist', 'python_specialist', 'lua_specialist', 'rust_specialist', 'gardener', 'accounts', 'records', 'dispositions', 'signoffs', 'proposals',
    'ratchet_refuse', 'intake', 'stuck_plans', 'science_pull', 'director_look', 'typescript_specialist',
    'daily_learnings', 'review_examples', 'director_fix_reach', 'tick_deps', 'watch', 'director_widen', 'target_parked_once', 'director_ceiling',
    'close_landed', 'handback_not_done', 'ruling_files', 'needs_ceo_actor', 'build_cap', 'ready_proof_stuck', 'card_facts',
    'director_findings', 'director_rule_dropped', 'rule_to_build', 'blind_review', 'drift_recovered', 'drift_refile', 'capture_swallowed_once', 'design_lead', 'daily_live', 'paydesk_live', 'site_data', 'site_pipe', 'lane_back_on', 'house_generator', 'design_on_main', 'earth_lodge_site', 'site_push', 'director_design_waive', 'gpg_lock_hold', 'bench_no_properties', 'fork_actions_off', 'director_repeat_return', 'fork_unrun', 'refile_carries', 'offline_hold', 'research_quote_text', 'research_moving_ref', 'ruling_unmoved', 'director_to_fixer', 'return_at', 'bench_score_hold', 'director_close_unbuilt', 'waits_closed_released', 'mended_by_commit', 'outside_records', 'base_recut', 'comms_not_a_post'])
  expect(drift(d, REGISTRY, NOW).map((r) => r.name)).not.toContain('build_cap')
  expect(drift(d, REGISTRY, NOW).map((r) => r.name)).not.toContain('site_pipe')
  expect(drift(d, REGISTRY, NOW).map((r) => r.name)).not.toContain('director_widen')
  expect(drift(d, REGISTRY.filter((e) => e.name === 'watch'), NOW)).toEqual([])
  expect(ratchetRules(d).mode).toBe('refuse')
  expect(drift(d, REGISTRY, NOW).map((r) => r.name)).not.toContain('tick_deps')
  expect(drift(d, REGISTRY, NOW).map((r) => r.name)).not.toContain('target_parked_once')
  expect(drift(d, REGISTRY, NOW).map((r) => r.name)).not.toContain('ratchet_refuse')
  expect(drift(d, REGISTRY, NOW).map((r) => r.name)).not.toContain('accepted_findings')
  for (const bad of [{ gap: '2 days' }, { table: 'events;' }, { column: 'At' }]) {
    expect(() => Entry.parse({ name: 'x', ...bad })).toThrow()
  }
  const old = db()
  event(old, '2026-10-02 10:00:00', 'coo_lite')
  expect(drift(old, REGISTRY.filter((e) => e.name === 'director'), NOW)).toEqual([])
})

test('growth_lead is silent only after a growth plan', () => {
  const d = db()
  const growth = REGISTRY.filter((e) => e.name === 'growth_lead')
  const comms = (title: string, step: number) => d.exec(`INSERT INTO plans (pipe_id, template, state, queued_at, step, title)
    VALUES ((SELECT id FROM pipes WHERE name = 'comms'), 'comms', 'queued', '2026-10-01', ${String(step)}, '${title}')`)
  expect(drift(d, growth, NOW)).toEqual([])
  comms('scorecard 2026-09-28', 9)
  expect(drift(d, growth, NOW)).toEqual([])
  comms('growth 2026-10-01', 7)
  expect(drift(d, growth, NOW)).toEqual([{ name: 'growth_lead', state: 'silent', detail: "no row in runs WHERE seat = 'growth_lead'" }])
})

test('D4 a card opened without its sheet is seen', () => {
  const d = db()
  logged(d, { plan: 1, kind: 'card_facts', actor: 'signoff', outcome: 'pass', message: 'with fact sheet', pointer: null, run: null })
  expect(drift(d, REGISTRY, NOW).map((r) => r.name)).not.toContain('card_facts')
  logged(d, { plan: 1, kind: 'card_facts', actor: 'signoff', outcome: 'refuse', message: 'without fact sheet', pointer: null, run: null },
    '2026-10-02 10:00:00')
  expect(drift(d, REGISTRY, NOW).find((r) => r.name === 'card_facts')?.state).toBe('seen')
})

test('D5 a builder hand-off with no step-2 build is seen', () => {
  const d = db()
  logged(d, { plan: 1, kind: 'director', actor: 'director', outcome: 'pass',
    message: "rule: x (out of the fixer's reach, so the builder takes it)", pointer: null, run: null }, '2026-10-02 10:00:00')
  expect(drift(d, REGISTRY, NOW).find((r) => r.name === 'rule_to_build')?.state).toBe('seen')
  addRule(d, { id: 'typescript_specialist', kind: 'card', path: 'rules/roster.yaml', content_hash: '0'.repeat(64), loaded_at: '2026-09-22' })
  runAt(d, 1, 2, 'typescript_specialist', '2026-10-02 12:00:00')
  expect(drift(d, REGISTRY, NOW).map((r) => r.name)).not.toContain('rule_to_build')
})

test('D1-D6 a fork left with Actions off a day is seen', () => {
  const off = REGISTRY.filter((e) => e.name === 'fork_actions_off')
  const states = (after: [number, string, string] | null, at: string | null = '2026-10-02 10:00:00', now = NOW): string[] => {
    const d = db()
    putPlan(d, { id: 2, pipe_id: planById(d, 1).pipe_id, target_id: null, template: 'comms', state: 'queued', queued_at: '2026-10-01', step: 0, retries: 0 })
    logged(d, { plan: 1, kind: 'ready', actor: 'tick', outcome: 'escalate', pointer: null, run: null,
      message: 'caliperforge/widget has Actions off for its workflows: enable them at x, then cf return 1' }, at)
    if (after !== null) logged(d, { plan: after[0], kind: after[1], actor: 'ceo', outcome: 'pass', message: 'm', pointer: null, run: null }, after[2])
    return drift(d, off, now).map((r) => r.state)
  }
  expect(drift(db(), off, NOW)).toEqual([])
  expect(states([1, 'return', '2026-10-02 12:00:00'])).toEqual([])
  expect(states([1, 'ready', '2026-10-02 12:00:00'])).toEqual([])
  expect(states(null)).toEqual(['seen'])
  expect(states([1, 'return', '2026-10-04 10:00:00'])).toEqual(['seen'])
  expect(states([2, 'return', '2026-10-02 12:00:00'])).toEqual(['seen'])
  expect(states(null, null, new Date())).toEqual([])
})

test('D1-D4 only a network hold left unresumed 2h is seen', () => {
  const hold = REGISTRY.filter((e) => e.name === 'offline_hold')
  const states = (after: [number, string] | null, at: string | null = '2026-10-02 10:00:00', now = NOW): unknown[] => {
    const d = db()
    putPlan(d, { id: 2, pipe_id: planById(d, 1).pipe_id, target_id: null, template: 'comms', state: 'queued', queued_at: '2026-10-01', step: 0, retries: 0 })
    logged(d, { plan: 1, kind: 'step', actor: 'tick', outcome: 'pass', pointer: null, run: null,
      message: 'step 2 build: the network is down; the next tick tries again' }, at)
    if (after !== null) logged(d, { plan: after[0], kind: 'step', actor: 'tick', outcome: 'pass', message: 'm', pointer: null, run: null }, after[1])
    return drift(d, hold, now)
  }
  expect(states([1, '2026-10-02 11:00:00'])).toEqual([])
  expect(states(null)).toMatchObject([{ name: 'offline_hold', state: 'seen', newest: '2026-10-02 10:00:00' }])
  expect(states(null, null, new Date())).toEqual([])
  expect(states([2, '2026-10-02 11:00:00'])).toMatchObject([{ name: 'offline_hold', state: 'seen' }])
})

test('D3 D4 a repeat ci.unrun on one sha is seen', () => {
  const d = db()
  const unrun = REGISTRY.filter((e) => e.name === 'fork_unrun')
  const log = (pointer: string | null): number =>
    logged(d, { plan: 1, kind: 'ci.unrun', actor: 'tick', outcome: 'pass', message: 'm', pointer, run: null }, '2026-10-02 10:00:00')
  log(null)
  log(null)
  log('a')
  log('b')
  expect(drift(d, unrun, NOW)).toEqual([])
  log('a')
  expect(drift(d, unrun, NOW).map((r) => r.state)).toEqual(['seen'])
})

test('D1 D2 a passing ci.unrun is not seen; a refused one is', () => {
  const d = db()
  const unrun = REGISTRY.filter((e) => e.name === 'fork_unrun')
  const log = (outcome: 'pass' | 'refuse'): number =>
    logged(d, { plan: 1, kind: 'ci.unrun', actor: 'tick', outcome, message: 'm', pointer: outcome, run: null }, '2026-10-02 10:00:00')
  log('pass')
  expect(drift(d, unrun, NOW)).toEqual([])
  log('refuse')
  expect(drift(d, unrun, NOW).map((r) => r.state)).toEqual(['seen'])
})

test('D3 an open fork_unrun finding recovers', () => {
  const d = db()
  const unrun = REGISTRY.filter((e) => e.name === 'fork_unrun')
  const id = addFinding(d, { name: 'fork_unrun', state: 'seen', detail: 'expected none' }, NOW)
  logged(d, { plan: 1, kind: 'ci.unrun', actor: 'tick', outcome: 'pass', message: 'm', pointer: 'a', run: null }, '2026-10-02 10:00:00')
  expect(recovered(d, unrun, drift(d, unrun, NOW), NOW)).toEqual([id])
})

test('D5 a research.moving_ref refusal is seen', () => {
  const d = db()
  const moving = REGISTRY.filter((e) => e.name === 'research_moving_ref')
  expect(drift(d, moving, new Date())).toEqual([])
  refused(d, { plan: 1, step: 1, fingerprint: fingerprint(1, ['research.moving_ref']), diff: null, span: 'research.moving_ref' })
  expect(drift(d, moving, new Date()).map((r) => r.state)).toEqual(['seen'])
  logged(d, { plan: 1, kind: 'research.unpinned', actor: 'tick', outcome: 'pass', message: 'm', pointer: null, run: null })
  expect(drift(d, moving, new Date())).toEqual([])
})

test('D1-D3 a line is quiet until its gap since added', () => {
  const line = [{ ...COO, gap: '7d', added: '2026-10-23' }]
  expect(drift(db(), line, new Date('2026-10-29T10:00:00Z'))).toEqual([])
  expect(drift(db(), line, new Date('2026-10-30T10:00:00Z')))
    .toEqual([{ name: 'director', state: 'silent', detail: "no row in events WHERE kind = 'director'" }])
  const d = db()
  event(d, '2026-10-01 10:00:00')
  expect(drift(d, line, new Date('2026-10-25T10:00:00Z')).map((r) => r.state)).toEqual(['stale'])
})

test('D2 a second swallowed before a back is seen', () => {
  const d = db()
  const once = REGISTRY.filter((e) => e.name === 'capture_swallowed_once')
  const read = (kind: string, at: string): number =>
    logged(d, { plan: 1, kind, actor: 'reachable', outcome: 'pass', message: 'm', pointer: null, run: null }, at)
  read('swallowed', '2026-10-02 10:00:00')
  read('back', '2026-10-02 11:00:00')
  read('swallowed', '2026-10-02 12:00:00')
  expect(drift(d, once, NOW)).toEqual([])
  read('swallowed', '2026-10-02 13:00:00')
  expect(drift(d, once, NOW).map((r) => r.state)).toEqual(['seen'])
})
