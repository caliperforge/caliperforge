import { expect, test } from 'vitest'
import { logged } from '../../store/events.ts'
import { ratchetRules } from '../../store/lanes.ts'
import { drift, Entry } from '../drift.ts'
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
  expect(REGISTRY.map((e) => e.name)).toEqual(['director', 'fixer', 'fix_mode', 'swift_review', 'kotlin_review',
    'python_review', 'ruby_review', 'rust_review', 'go_review', 'php_review', 'typescript_review', 'brief_writer', 'text_review',
    'writer_log', 'writer_ship', 'writer_weekly', 'growth_lead', 'web_specialist', 'design', 'go_specialist', 'php_specialist', 'ruby_specialist', 'python_specialist', 'lua_specialist', 'rust_specialist', 'gardener', 'ratchet', 'accounts', 'records', 'dispositions', 'signoffs', 'proposals',
    'ratchet_refuse', 'intake', 'stuck_plans', 'science_pull', 'site_publish', 'director_look', 'typescript_specialist',
    'daily_learnings', 'review_examples', 'director_fix_reach', 'tick_deps', 'watch', 'director_widen', 'target_parked_once', 'director_ceiling',
    'close_landed', 'handback_not_done', 'ruling_files', 'needs_ceo_actor', 'build_cap', 'ready_proof_stuck', 'card_facts',
    'director_findings', 'director_rule_dropped'])
  expect(drift(d, REGISTRY, NOW).map((r) => r.name)).not.toContain('build_cap')
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

test('D4 a card opened without its sheet is seen', () => {
  const d = db()
  logged(d, { plan: 1, kind: 'card_facts', actor: 'signoff', outcome: 'pass', message: 'with fact sheet', pointer: null, run: null })
  expect(drift(d, REGISTRY, NOW).map((r) => r.name)).not.toContain('card_facts')
  logged(d, { plan: 1, kind: 'card_facts', actor: 'signoff', outcome: 'refuse', message: 'without fact sheet', pointer: null, run: null },
    '2026-10-02 10:00:00')
  expect(drift(d, REGISTRY, NOW).find((r) => r.name === 'card_facts')?.state).toBe('seen')
})
