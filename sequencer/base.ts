import { list, type Board, type Gh, type Head } from '../rails/ci-green/index.ts'
import { failing, type Failed } from './failures.ts'
import { maybe, put } from './workspace.ts'

/** `<branch> <sha>`: the plan's last head at which every judged run was green. */
export const GREEN = 'ci.green'

/** `<head> <run id>…`: the head the base was re-run for, once, and the re-runs not yet seen going. */
const ASKED = 'ci.base'

const ID = /\/actions\/runs\/(\d+)/

type Run = NonNullable<ReturnType<typeof list>>[number]

/**
 * #148: a job red at the head that fails again at the last green head, re-run, is the base's, not the
 * build's. The board returned carries those jobs; a string is what the head waits on; null refuses as before.
 */
export function onBase(root: string, plan: number, head: Head, spans: string[], board: Board[], gh: Gh): Board[] | string | null {
  const [branch, sha] = maybe(root, plan, GREEN)?.trim().split(' ') ?? []
  if (branch === undefined || sha === undefined || sha === head.sha || !spans.every((s) => s.endsWith(' ci.red'))) return null
  try {
    return compared(root, plan, head, { fork: head.fork, branch, sha }, spans, board, gh)
  } catch {
    return null
  }
}

function compared(root: string, plan: number, head: Head, base: Head, spans: string[], board: Board[], gh: Gh): Board[] | string | null {
  const reds = at(head, gh).filter((r) => spans.includes(`${r.url} ci.red`))
  const names = new Set(reds.map((r) => r.workflowName))
  const runs = at(base, gh).filter((r) => names.has(r.workflowName))
  if (reds.length === 0 || [...names].some((n) => !runs.some((r) => r.workflowName === n))) return null
  if (!settled(root, plan, head, runs, gh)) return `waits on ${[...names].join(', ')} re-running at ${base.sha.slice(0, 12)}`
  const theirs = runs.map((r) => ({ workflow: r.workflowName, failed: r.conclusion === 'success' ? [] : failing(head.fork, idOf(r), gh) }))
  const also = (workflow: string, f: Failed): boolean => theirs.some((t) => t.workflow === workflow && t.failed.some((g) => g.job === f.job))
  const excused = reds.every((r) => {
    const ours = failing(head.fork, idOf(r), gh)
    return ours.length > 0 && ours.every((f) => also(r.workflowName, f))
  })
  if (!excused) return null
  return board.map((row) => row.gates && names.has(row.workflow)
    ? { ...row, base: theirs.filter((t) => t.workflow === row.workflow).flatMap((t) => t.failed.map((f) => `${f.job}: ${f.step}`)) }
    : row)
}

function at(head: Head, gh: Gh): Run[] {
  return (list(head, gh) ?? []).filter((r) => r.headSha === head.sha)
}

/** A re-run lists its old conclusion until it starts, so a run asked for counts only once it has been seen going. */
function settled(root: string, plan: number, head: Head, runs: Run[], gh: Gh): boolean {
  const [asked, ...unseen] = (maybe(root, plan, ASKED) ?? '').trim().split(' ')
  const stale = asked === head.sha
    ? unseen.filter((id) => runs.some((r) => idOf(r) === id && r.status === 'completed'))
    : runs.filter((r) => r.status === 'completed' && r.conclusion === 'success').map(idOf)
  put(root, plan, ASKED, [head.sha, ...stale].join(' '))
  if (asked !== head.sha) for (const id of stale) gh(['run', 'rerun', id, '--repo', head.fork])
  return runs.every((r) => r.status === 'completed' && !stale.includes(idOf(r)))
}

function idOf(run: Run): string {
  return ID.exec(run.url)?.[1] ?? ''
}
