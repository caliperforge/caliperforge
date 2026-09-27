import { z } from 'zod'
import { maybe } from '../sequencer/workspace.ts'
import type { Db } from '../store/index.ts'
import { internal, originRef, PlanRow } from '../store/plans.ts'

const Row = PlanRow.extend({ waits_on: z.int().nullable() })

type Row = z.infer<typeof Row>

type Hit = [string, string] | null

export function flow(db: Db, root: string, now: Date): string[] {
  return db.prepare('SELECT * FROM plans ORDER BY id').all().map((r) => Row.parse(r)).flatMap((p) => {
    const note = maybe(root, p.id, 'parked.md')
    const hit = landed(db, p) ?? stale(db, p, note) ?? repeated(db, p, note, now) ?? ownerless(p, note)
    return hit === null ? [] : [`plan ${String(p.id)}\t${hit[0]}\t${hit[1]}\n`]
  })
}

function landed(db: Db, p: Row): Hit {
  if (!internal(p) || (p.state !== 'blocked_on_ceo' && p.state !== 'halted')) return null
  const pushed = db.prepare("SELECT 1 FROM deliverables WHERE plan_id = ? AND state = 'pushed'").get(p.id)
  return pushed === undefined ? null : [`landed on main, state ${p.state}`, `cf return ${String(p.id)}`]
}

function stale(db: Db, p: Row, note: string | null): Hit {
  if (note === null) return null
  if (p.state === 'done' || p.state === 'refused' || p.state === 'halted') {
    return [`held, state ${p.state}`, `rm .cf/work/${String(p.id)}/parked.md`]
  }
  const ref = originRef(p)
  if (p.state !== 'blocked_on_ceo' || ref === null) return null
  const { closed } = db.prepare(`SELECT EXISTS (SELECT 1 FROM tickets WHERE repo = ?)
    AND NOT EXISTS (SELECT 1 FROM tickets WHERE repo = ? AND number = ?) AS closed`).get(ref.repo, ref.repo, ref.no) as { closed: number }
  return closed === 1 ? [`held on closed issue #${String(ref.no)}`, `cf unpark ${String(p.id)}`] : null
}

function repeated(db: Db, p: Row, note: string | null, now: Date): Hit {
  if (p.state !== 'blocked_on_ceo' || note !== null) return null
  const stuck = db.prepare(`SELECT 1 FROM refusals f
    WHERE f.id = (SELECT max(id) FROM refusals WHERE plan = ? AND cleared = 0 AND blip = 0)
      AND EXISTS (SELECT 1 FROM refusals e WHERE e.plan = f.plan AND e.id < f.id AND e.cleared = 0 AND e.blip = 0
        AND e.fingerprint = f.fingerprint)
      AND julianday(f.at) < julianday(?, '-30 minutes')
      AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.plan = f.plan AND julianday(d.at) > julianday(f.at))`)
    .get(p.id, now.toISOString())
  return stuck === undefined ? null : ['stopped on a repeated refusal', `cf retry ${String(p.id)}`]
}

function ownerless(p: Row, note: string | null): Hit {
  if (note === null || note.includes('/issues/') || p.state !== 'blocked_on_ceo' || p.waits_on !== null) return null
  return ['held with no owner', `cf unpark ${String(p.id)}`]
}
