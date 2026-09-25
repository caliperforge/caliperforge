import type { Provider } from '../providers/kind.ts'
import { parse } from '../rails/diff.ts'
import { TEST_FILE } from '../rails/test-weakened/index.ts'
import { record } from '../reviews/bench.ts'
import type { Finding, Verdict } from '../reviews/verdict.ts'
import { digestOf } from '../store/approvals.ts'
import type { Db } from '../store/index.ts'
import { internal, type PlanRow } from '../store/plans.ts'
import { at, type Step } from '../templates/pr-path.ts'
import { checks } from './checks.ts'
import type { Outcome } from './kind.ts'
import { fireReview, ran } from './seat.ts'
import { languageFor } from './route.ts'
import { diffOf, diffSince, get, srcDir } from './workspace.ts'

/** The fence a fix stays inside: every changed line within `NEAR` of one a finding named, `CAP` changed lines in all. */
const NEAR = 5
const CAP = 20

/**
 * Steps 4 and 5. A refusal whose every finding is `cosmetic` is one builder fire away from settled, so it
 * is fixed in place and verified mechanically rather than rewinding the plan to the build. Anything the
 * lane cannot verify is the reviewer's own refusal, and the lap is the one the plan would have taken.
 */
export async function fireRound(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  const { outcome: verdict, findings, tree } = await fireReview(db, root, plan, step, provider)
  if (verdict.outcome !== 'refuse' || tree === null) return verdict
  if (findings.length === 0 || !findings.every((f) => f.kind === 'cosmetic')) return verdict
  const src = srcDir(root, plan.id)
  const fired = await ran(db, root, plan, at(2, languageFor(db, plan, src)), provider, asked(root, plan.id, findings), internal(plan))
  if (fired.ended !== 'completed') return verdict
  if (strayed(diffSince(src, tree), findings)) return verdict
  if (internal(plan) && checks(src) !== null) return verdict
  record(db, root, step.runs, plan.id, settled(diffOf(root, plan.id)), 0, fired.seconds, null, 1)
  return { outcome: 'pass', spans: [], note: `${step.runs} ${String(findings.length)} cosmetic finding(s) fixed in place` }
}

/** The builder's packet: the brief it built against, and each span with the text that replaces it. */
function asked(root: string, plan: number, findings: Finding[]): string {
  const fixes = findings.map((f) => (f.fix === null ? `- ${f.span}` : `- ${f.span}\n\n\`\`\`\n${f.fix}\n\`\`\``))
  return `${get(root, plan, 'issue.md')}\n\n# Refused — make these fixes and change nothing else\n\n${fixes.join('\n')}\n`
}

function strayed(diff: string, findings: Finding[]): boolean {
  const files = parse(diff)
  const changed = files.flatMap((f) => [...f.added, ...f.removed])
  if (changed.length > CAP || files.some((f) => TEST_FILE.test(f.path))) return true
  const named = lines(findings)
  return changed.some((l) => !(named.get(l.path) ?? []).some((n) => Math.abs(n - l.line) <= NEAR))
}

const SPAN = /^(.+):(\d+)\b/

function lines(findings: Finding[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const f of findings) {
    const named = SPAN.exec(f.span)
    if (named === null) continue
    const path = named[1] ?? ''
    out.set(path, [...(out.get(path) ?? []), Number(named[2])])
  }
  return out
}

function settled(diff: string): Verdict {
  return {
    outcome: 'pass',
    defect_class: null,
    spans: [],
    subject_digest: digestOf(diff),
    origin_kind: null,
    origin_ref: null,
    message: 'quick lane',
  }
}
