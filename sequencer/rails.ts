import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { authority } from '../rails/authority/index.ts'
import { audit, record } from '../rails/completion-audit/index.ts'
import { parse } from '../rails/diff.ts'
import { identifiers } from '../rails/identifiers/index.ts'
import { record as recordRail, type Verdict } from '../rails/record.ts'
import { scan } from '../rails/secret-scan/index.ts'
import { weakened } from '../rails/test-weakened/index.ts'
import { tight } from '../rails/tight/index.ts'
import type { Db } from '../store/index.ts'
import { internal, type PlanRow } from '../store/plans.ts'
import { builder } from '../templates/pr-path.ts'
import type { Outcome } from './kind.ts'
import { diffOf, doneIds, get, languageOf, srcDir } from './workspace.ts'

/** Step 3: the six rails the map's step list names, in its order, ending at the first refusal. No reviewer tokens. */
export function preReview(db: Db, root: string, plan: PlanRow): Outcome {
  const handback = get(root, plan.id, 'step-2.handback.md')
  const first = audit(handback, doneIds(get(root, plan.id, 'issue.md')))
  record(db, plan.id, first, 0)
  if (first.outcome !== 'pass') return named('completion-audit', first)
  for (const [rail, run] of rest(root, plan, handback)) {
    const verdict = run()
    recordRail(db, join(root, 'rails', rail), plan.id, verdict, 0)
    if (verdict.outcome !== 'pass') return named(rail, verdict)
  }
  return { outcome: 'pass', spans: [], note: 'pre-review: six rails pass' }
}

function rest(root: string, plan: PlanRow, handback: string): [string, () => Verdict][] {
  const src = srcDir(root, plan.id)
  const diff = diffOf(root, plan.id)
  return [
    ['secret-scan', () => scan(diff)],
    ['authority', () => authority(root, builder(languageOf(src)), diff, internal(plan))],
    ['tight', () => tight(root, { diff, sources: sources(src, diff), description: handback })],
    ['test-weakened', () => weakened(diff, 'green')],
    ['identifiers', () => identifiers(src, handback)],
  ]
}

/** Tight reads the whole function a hunk lands in, so it needs the file as the checkout now holds it. */
function sources(src: string, diff: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const file of parse(diff)) {
    const path = join(src, file.path)
    if (file.deleted || !file.path.endsWith('.ts') || !existsSync(path)) continue
    out[file.path] = readFileSync(path, 'utf8')
  }
  return out
}

function named(rail: string, verdict: Verdict): Outcome {
  return { outcome: verdict.outcome, spans: verdict.spans, note: `${rail}: ${verdict.message}` }
}
