import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../checks/sqlite.ts'
import { addRun } from './brief.ts'
import { metric, METRICS } from './metrics.ts'
import { putPlan } from './plans.ts'
import { addAccount, addTarget } from './targets.ts'

function homes(): { columns: string[]; rows: unknown[][] } {
  const db = fresh(join(import.meta.dirname, '..', 'schema'))
  db.exec(`INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES ('internal', 1, '00:00', '23:59', 1);
    INSERT INTO rules (id, kind, path, content_hash, loaded_at) VALUES ('typescript_specialist', 'roster', 'seats/typescript_specialist', printf('%064d', 0), '2026-09-01')`)
  addAccount(db, { id: 1, repo: 'acme/widget', measured_at: '2026-09-01', maintainers: 1, doors: 1, last_outsider_merge: null,
    open_pr_age_p50_days: 1, cross_repo_activity: 0, pulse: 'cold', evidence: 'e' })
  const target = (repo: string): number => addTarget(db, { account_id: 1, repo, issue_no: 1, named_merger: 'm', state: 'queued',
    evidence_measured_at: '2026-09-01', evidence: 'e' })
  const [acme, site] = [target('acme/widget'), target('caliperforge/site')]
  for (const [id, target_id, state, at] of [[1, acme, 'done', '2026-09-22'], [2, site, 'done', '2026-09-29'], [3, null, 'done', '2026-10-06'],
    [4, acme, 'refused', '2026-10-06']] as const) {
    putPlan(db, { id, pipe_id: 1, target_id, template: 'research', state, queued_at: at, step: 2, retries: 0 })
    addRun(db, { seat: 'typescript_specialist', at: `${at}T09:00:00.000Z`, input_tokens: 1, cache_write_tokens: 0, cache_read_tokens: 0,
      output_tokens: 1, plan: id, step: 2, rule_hash: '0'.repeat(64), provider: 'claude-agent-sdk', model: 'm', effort: 'high',
      cache_write_1h_tokens: null, seconds: 1, exit: 0, transcript_path: 't.transcript.jsonl', cost_usd: 0 })
  }
  return metric(db, METRICS.loop_counts, '2026-10-07')
}

const pick = ({ columns, rows }: { columns: string[]; rows: unknown[][] }, names: string[]): unknown[][] =>
  rows.map((r) => names.map((n) => r[columns.indexOf(n)]))

test('D1 the two homes add up to landed in every period', () => {
  const rows = pick(homes(), ['landed', 'landed_caliperforge', 'landed_outside'])
  expect(rows).toHaveLength(5)
  for (const [landed, ours, outside] of rows) expect(Number(ours) + Number(outside)).toBe(landed)
})

test('D2 D3 D4 an outside plan counts only when done, as outside', () => {
  expect(pick(homes(), ['period', 'landed', 'landed_caliperforge', 'landed_outside'])).toEqual([['2026-09-21', 1, 0, 1],
    ['2026-09-28', 1, 1, 0], ['2026-10-05', 1, 1, 0], ['all', 3, 2, 1], ['last_7_days', 1, 1, 0]])
})
