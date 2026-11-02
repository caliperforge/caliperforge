import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Refused } from './handoff.ts'
import { measured, type Revert } from './reach.ts'
import { callee, NONE, rows } from './slices.ts'

export interface Smoked { name: string; calls: number; successes: number }

const REPORT = 'corpus_medusa/coverage/revert_report.json'
const SECONDS = '120'

export function smoked(map: string, report: string): Smoked[] {
  const metrics = measured(JSON.parse(readFileSync(report, 'utf8')) as Revert)
  return (rows(map).get('Selected entry points') ?? []).filter((r) => r.name !== NONE).map(({ name }) => {
    const { totalCalls, totalReverts } = metrics(name)
    return { name, calls: totalCalls, successes: totalCalls - totalReverts }
  })
}

export function unrun(map: string, results: Smoked[]): Refused[] {
  const unclamped = (rows(map).get('Unclamped') ?? []).map((r) => r.name)
  return results.filter((r) => r.successes === 0 && unclamped.includes(callee(r.name))).map((r) => ({ rule: 'smoke.unclamped',
    note: `smoke: ${r.name} is raw-only and made 0 successful calls in ${String(r.calls)}; it needs a clamped handler` }))
}

export function smoke(root: string, fizz: string, meta: string, map: string): Smoked[] {
  const path = join(root, 'medusa.json')
  const kept = readFileSync(path, 'utf8')
  const config = JSON.parse(kept) as { fuzzing?: object }
  writeFileSync(path, JSON.stringify({ ...config, fuzzing: { ...config.fuzzing, revertReporterEnabled: true } }, null, 2))
  try {
    spawnSync('node', [join(fizz, 'scripts/run_medusa.js'), root, '--meta-dir', meta, '--timeout', SECONDS], { cwd: root })
  } finally {
    writeFileSync(path, kept)
  }
  return smoked(map, join(root, meta, REPORT))
}

export const packed = (results: Smoked[]): string =>
  results.map((r) => `- ${r.name} | calls: ${String(r.calls)} | successes: ${String(r.successes)}\n`).join('')
