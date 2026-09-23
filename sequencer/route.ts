import { filesOf } from '../store/files.ts'
import type { Db } from '../store/index.ts'
import { internal, type PlanRow } from '../store/plans.ts'
import { languageOf } from './workspace.ts'
import { kernelPlan } from './home.ts'

/** The manifest entry that says a seat's fence is the file list the brief settled, not a directory. */
export const BRIEF_FILES = 'brief:files'

/**
 * Which builder a plan gets. The kernel's own repo is TypeScript; another repo of ours is what its tree is written in (#69). On a stranger's repo the brief's files decide: all
 * under `kotlin/` is the Kotlin seat, anything else the outside seat -- a repo that merely has a
 * `kotlin/` folder no longer sends a Ruby change to the Kotlin seat.
 */
export function languageFor(db: Db, plan: PlanRow, src: string): string | null {
  if (internal(plan)) return kernelPlan(plan) ? null : languageOf(src)
  const paths = filesOf(db, plan.id).map((f) => f.path)
  if (paths.length === 0) return languageOf(src)
  return paths.every((p) => p.startsWith('kotlin/')) ? 'kotlin' : 'outside'
}

/** The paths a seat may write: its manifest's, or the brief's files where the manifest says so. */
export function fenceFor(db: Db, plan: number, writePaths: string[]): string[] {
  return writePaths.includes(BRIEF_FILES) ? filesOf(db, plan).map((f) => f.path) : writePaths
}
