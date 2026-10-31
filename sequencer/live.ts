import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../rails/diff.ts'
import { TEST_FILE } from '../rails/test-weakened/index.ts'
import type { Gated } from '../reviews/package.ts'
import type { PlanRow } from '../store/plans.ts'
import { npm } from './checks.ts'
import { kernelPlan } from './home.ts'
import { maybe, put, srcDir } from './workspace.ts'

/** The live tests' own timeout. */
const LIVE_CAP = 60 * 60 * 1000

const GATE = /process\.env\.CF_BENCH_LIVE\b/

const TAIL = 80

const FILE = 'live.md'

function digest(diff: string): string {
  return createHash('sha256').update(diff).digest('hex')
}

function gatedTests(src: string, diff: string): string[] {
  return parse(diff).filter((f) => !f.deleted && TEST_FILE.test(f.path)).map((f) => f.path)
    .filter((path) => existsSync(join(src, path)) && GATE.test(readFileSync(join(src, path), 'utf8')))
}

export function live(root: string, plan: PlanRow, diff: string, run = npm): void {
  if (!kernelPlan(plan)) return
  const src = srcDir(root, plan.id)
  const files = gatedTests(src, diff)
  const sha = digest(diff)
  if (files.length === 0 || maybe(root, plan.id, FILE)?.split('\n')[0] === sha) return
  const ran = run(['exec', '--', 'vitest', 'run', ...files], src, 'npm', LIVE_CAP, undefined, { CF_BENCH_LIVE: '1' })
  const output = ran.output.split('\n').slice(-TAIL).join('\n')
  put(root, plan.id, FILE, `${sha}\n${ran.ok ? 'pass' : 'fail'}\nCF_BENCH_LIVE=1 npm exec -- vitest run ${files.join(' ')}\n${output}`)
}

export function lived(root: string, plan: PlanRow, diff: string): (Gated & { output: string }) | null {
  const [sha, outcome, command = '', ...output] = (maybe(root, plan.id, FILE) ?? '').split('\n')
  if (sha !== digest(diff)) return null
  return { language: 'live', dir: '', command, ...(outcome === 'pass' ? {} : { outcome: 'fail' as const }), output: output.join('\n') }
}
