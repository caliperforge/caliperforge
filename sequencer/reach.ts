import { relative, resolve } from 'node:path'
import { real } from '../runner/index.ts'
import { seat } from '../runner/rules.ts'
import { FORK, planDir } from './workspace.ts'

const BARRED: [RegExp, string][] = [
  [/\b(?:gh|git)\s+\w/, 'the fixer has no git and no GitHub'],
  [/\b(?:open|file|create|move|close|reopen)\s+(?:an?\s+|the\s+)?(?:[\w-]+\s+)?issue\b(?!\.)/i, 'the fixer opens no issue, use file'],
  [/\b(?:make|create|amend|push)\s+(?:an?\s+|the\s+)?commit\b(?!\.)/i, 'the fixer makes no commit'],
  [/\b(?:INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b|\bcf\.db\b|\bthe store\b/, 'the fixer writes no store row'],
]

/** A fix that rewrites the brief names checkout paths as the brief's text. */
const BRIEF = /\bissue\.md\b/

/** A `Fork:` line naming one of our repos is ask.md's text, not a path. */
const FORKED = new RegExp(`\\bFork:\\s*\`?${FORK}/[\\w.-]+`, 'g')

function reach(why: string, paths: string[], root: string, plan: number): string | null {
  const brief = BRIEF.test(why)
  const dir = real(planDir(root, plan))
  const path = why.replace(FORKED, 'Fork:').split(/\s+/).map((t) => t.replace(/^[`'"([{]+|[`'")\]}.,;:]+$/g, ''))
    .find((t) => (t.includes('/') || /\.[a-z]{2,5}$/i.test(t)) && !paths.includes(t)
      && !paths.includes(relative(dir, real(resolve(root, t))))
      && !(brief && !/^[~/]|^\.cf\/|(?:^|\/)\.\.(?:\/|$)/.test(t)))
  if (path !== undefined) return `\`${path}\` is outside the fixer's write_paths`
  return BARRED.find(([barred]) => barred.test(why))?.[1] ?? null
}

export function outOfReach(root: string, plan: number, why: string): { fence: string; message: string } | null {
  const paths = seat(root, 'fixer').manifest.write_paths
  const r = reach(why, paths, root, plan)
  if (r === null) return null
  return { fence: `fix is refused: ${r}. The fixer writes only ${paths.join(', ')} in this job's folder. Choose another move.`,
    message: `fix: refused by the fence, ${r}` }
}

/** A fix that only reaches past the fixer's files, into the job's code: the builder can take it as a ruling. */
export function builderWork(root: string, plan: number, why: string): boolean {
  const r = reach(why, seat(root, 'fixer').manifest.write_paths, root, plan)
  return r !== null && r.endsWith("is outside the fixer's write_paths") && !/\bcf\.db\b|\.cf\/|\bFork:/.test(why)
    && !BARRED.some(([barred]) => barred.test(why))
}

/** Waits a plan is right to sit in: a fork CI or a pace window. Nobody needs telling. */
export const WAITING = new Set(['ready_proof', 'target_parked'])
