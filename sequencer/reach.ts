import { seat } from '../runner/rules.ts'

const BARRED: [RegExp, string][] = [
  [/\b(?:gh|git)\s+\w/, 'the fixer has no git and no GitHub'],
  [/\b(?:open|file|create|move|close|reopen)\s+(?:an?\s+|the\s+)?(?:[\w-]+\s+)?issue\b(?!\.)/i, 'the fixer opens no issue, use file'],
  [/\b(?:make|create|amend|push)\s+(?:an?\s+|the\s+)?commit\b(?!\.)/i, 'the fixer makes no commit'],
  [/\b(?:INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b|\bcf\.db\b|\bthe store\b/, 'the fixer writes no store row'],
]

function reach(why: string, paths: string[]): string | null {
  const path = why.split(/\s+/).map((t) => t.replace(/^[`'"([{]+|[`'")\]}.,;:]+$/g, ''))
    .find((t) => (t.includes('/') || /\.[a-z]{2,5}$/i.test(t)) && !paths.includes(t))
  if (path !== undefined) return `\`${path}\` is outside the fixer's write_paths`
  return BARRED.find(([barred]) => barred.test(why))?.[1] ?? null
}

export function outOfReach(root: string, why: string): { fence: string; message: string } | null {
  const paths = seat(root, 'fixer').manifest.write_paths
  const r = reach(why, paths)
  if (r === null) return null
  return { fence: `fix is refused: ${r}. The fixer writes only ${paths.join(', ')} in this job's folder. Choose another move.`,
    message: `fix: refused by the fence, ${r}` }
}

/** A fix that only reaches past the fixer's files, into the job's code: the builder can take it as a ruling. */
export function builderWork(root: string, why: string): boolean {
  const r = reach(why, seat(root, 'fixer').manifest.write_paths)
  return r !== null && r.endsWith("is outside the fixer's write_paths") && !/\bcf\.db\b|\.cf\//.test(why)
    && !BARRED.some(([barred]) => barred.test(why))
}

/** Waits a plan is right to sit in: a fork CI or a pace window. Nobody needs telling. */
export const WAITING = new Set(['ready_proof', 'target_parked'])
