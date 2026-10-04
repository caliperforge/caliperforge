import type { Provider } from '../providers/kind.ts'
import { packet } from '../runner/index.ts'
import { seat, tight } from '../runner/rules.ts'
import { filesOf } from '../store/files.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import { pending } from '../store/transcript.ts'
import { builder } from '../templates/pr-path.ts'
import { kernelPlan } from './home.ts'
import { fenceFor, languageOfSpan, pathOfSpan, TEST } from './route.ts'
import { recorded } from './seat.ts'
import { maybe, planDir, srcDir } from './workspace.ts'

/** The builder seat for a code stop, or null for a stop on the machine's own state; red CI names its tests in the log. */
export function coder(db: Db, root: string, plan: PlanRow): string | null {
  const text = maybe(root, plan.id, 'refusal.md') ?? ''
  const block = /^spans:\n((?: {2}.*(?:\n|$))*)/m.exec(text)?.[1] ?? ''
  const spans = block.split('\n').filter((l) => l.startsWith('  - ')).map((l) => l.slice(4))
  const red = spans.some((s) => s.includes('ci.red'))
  const named = (red ? text.split(/\s+/).filter((w) => TEST.test(w)) : spans).filter((c) => languageOfSpan(c) !== null)
  const [language, ...more] = new Set(named.flatMap((c) => languageOfSpan(c) ?? []))
  if (language === undefined || more.length > 0) return null
  const files = new Set(filesOf(db, plan.id).map((f) => f.path))
  const free = red || spans.some((s) => s.startsWith('checks:'))
  return free || named.every((c) => files.has(pathOfSpan(c))) ? builder(language) : null
}

/** The language seat makes the repair in a fresh conversation, from the fixer's diagnosis and the stop. */
export async function repaired(db: Db, root: string, plan: PlanRow, to: string, issue: string, wall: number,
  provider: Provider): Promise<boolean> {
  const { manifest, prompt, hash } = seat(root, to)
  const fired = await provider.fire({
    ...packet(manifest, prompt, tight(root), issue, srcDir(root, plan.id), pending(planDir(root, plan.id), `fix-${to}`),
      kernelPlan(plan), fenceFor(db, plan.id, manifest.write_paths)),
    wall,
  })
  recorded(db, plan.id, plan.step, to, hash, provider.name, manifest, fired, 'fix')
  return fired.ended === 'completed'
}
