import { expect, test } from 'vitest'
import { decide } from '../../store/approvals.ts'
import { propose } from '../../store/proposals.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

test('proposals', () => {
  const d = db()
  const proposals = REGISTRY.filter((e) => e.name === 'proposals')
  expect(drift(d, proposals, NOW)).toEqual([])
  const id = propose(d, { class: 'ruling', subject: 'fixer.mode', value: 'live', match_ruling_id: null, match_issue_no: null, evidence: 't.jsonl:1' }) ?? 0
  expect(drift(d, proposals, NOW)).toEqual([{ name: 'proposals', state: 'silent', detail: "no row in approvals WHERE subject_kind = 'proposal'" }])
  decide(d, 'proposal', id, 'a'.repeat(64), 'no')
  expect(drift(d, proposals, NOW)).toEqual([])})
