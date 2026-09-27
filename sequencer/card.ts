import { decide, digestOf } from '../store/approvals.ts'
import type { Db } from '../store/index.ts'
import { busy } from '../store/now.ts'
import { conventions } from './conventions.ts'
import type { Outcome } from './kind.ts'
import { lead } from './lead.ts'
import { weight } from './weight.ts'
import { maybe, put } from './workspace.ts'

export interface Row { check: string; ok: boolean; says: string }
export interface Target { repo: string; issue_no: number; named_merger: string }
export type Check = (db: Db, root: string, plan: number, target: Target) => Row

export const CHECKS: Check[] = [lead, weight, conventions]

const CARD = 'maintainer.md'

export function waiting(db: Db, root: string, plan: number, sha: string, target: Target, checks: Check[] = CHECKS): Outcome | null {
  const rows = checks.map((check) => check(db, root, plan, target))
  const text = [`plan ${String(plan)} at ${sha}`, ...rows.map((r) => `${r.ok ? 'pass' : 'flag'}\t${r.check}\t${r.says}`)]
    .map((line) => `${line}\n`).join('')
  put(root, plan, CARD, text)
  const digest = digestOf(text)
  const decisions = (db.prepare("SELECT decision FROM approvals WHERE subject_kind = 'publish' AND subject_id = ? AND subject_digest = ?")
    .all(plan, digest) as { decision: string }[]).map((row) => row.decision)
  if (decisions.includes('approved')) return null
  const flags = rows.filter((r) => !r.ok).length
  const note = `card ${digest.slice(0, 12)} with ${String(flags)} flag(s): cf approve card ${String(plan)} or cf refuse card ${String(plan)} <reason>`
  if (decisions.includes('refused')) return { outcome: 'needs_ceo', spans: ['card'], note }
  busy(db, plan, 'waiting on the card', note)
  return { outcome: 'pass', held: true, spans: ['card'], note }
}

export function approve(db: Db, root: string, plan: number): string {
  return decided(db, root, plan, null)
}

export function refuse(db: Db, root: string, plan: number, reason: string): string {
  return decided(db, root, plan, reason)
}

function decided(db: Db, root: string, plan: number, reason: string | null): string {
  const text = maybe(root, plan, CARD)
  if (text === null) throw new Error(`plan ${String(plan)} has no card`)
  const digest = digestOf(text)
  decide(db, 'publish', plan, digest, reason)
  return digest
}
