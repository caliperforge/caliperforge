import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isScalar, parseDocument } from 'yaml'
import type { Board } from '../rails/ci-green/index.ts'
import { carried } from '../rails/completion-audit/index.ts'
import type { Verdict } from '../rails/record.ts'
import { maybe, srcDir } from './workspace.ts'

interface Owed { file: string; name: string }

/** Each workflow file a hand-back `ci` row names, and the name its runs show on the board: its `name:`, else its path. */
export function owed(root: string, plan: number): Owed[] {
  const rows = carried(maybe(root, plan, 'step-2.handback.md') ?? '')
  if (typeof rows === 'string') return []
  return [...rows.values()].filter((row) => row.status === 'ci').map((row) => {
    const file = (row.pointer ?? '').split(':')[0] ?? ''
    return { file, name: named(join(srcDir(root, plan), file)) ?? file }
  })
}

function named(path: string): string | null {
  if (!existsSync(path)) return null
  const name = parseDocument(readFileSync(path, 'utf8')).get('name', true)
  return isScalar(name) && typeof name.value === 'string' ? name.value : null
}

/** The judged head, an owed run that ended red refusing it whether or not `mine()` gates that run, and the owed files with no run on the board. */
export function owing(root: string, plan: number, judged: { verdict: Verdict; board: Board[] }): { verdict: Verdict; board: Board[]; absent: string[] } {
  const owes = owed(root, plan)
  const absent = owes.filter((o) => !judged.board.some((r) => r.workflow === o.name)).map((o) => o.file)
  return { ...judged, verdict: reddened(judged.verdict, judged.board, owes), absent }
}

function reddened(verdict: Verdict, board: Board[], owes: Owed[]): Verdict {
  const red = board.filter((r) => owes.some((o) => o.name === r.workflow) && r.status === 'completed' && r.conclusion !== 'success')
  const spans = red.map((r) => `${r.url ?? r.workflow} ci.red`).filter((s) => !verdict.spans.includes(s))
  if (spans.length === 0) return verdict
  return { ...verdict, outcome: 'refuse', origin_kind: 'rail', origin_ref: 'ci-green', spans: [...verdict.spans, ...spans],
    message: verdict.outcome === 'refuse' ? verdict.message : `${red.map((r) => r.workflow).join(', ')}, owed by the hand-back as ci, is red` }
}
