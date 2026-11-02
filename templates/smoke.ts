import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Refused } from './handoff.ts'
import { measured, type Revert } from './reach.ts'
import { callee, NONE, rows } from './slices.ts'

export interface Smoked { name: string; calls: number; successes: number }

const REPORT = 'corpus_medusa/coverage/revert_report.json'
const SECONDS = '120'
const TAIL = 2000

export function smoked(map: string, report: string): Smoked[] {
  const metrics = measured(JSON.parse(readFileSync(report, 'utf8')) as Revert)
  const mapped = rows(map)
  const handlers = mapped.get('Handlers') ?? []
  return (mapped.get('Selected entry points') ?? []).filter((r) => r.name !== NONE).map(({ name }) => {
    const read = handlers.filter((h) => h.cells.get('target') === callee(name)).map((h) => metrics(h.name))
    const calls = read.reduce((n, m) => n + m.totalCalls, 0)
    return { name, calls, successes: calls - read.reduce((n, m) => n + m.totalReverts, 0) }
  })
}

export function unrun(map: string, results: Smoked[]): Refused[] {
  const unclamped = (rows(map).get('Unclamped') ?? []).map((r) => r.name)
  return results.filter((r) => r.successes === 0 && unclamped.includes(callee(r.name))).map((r) => ({ rule: 'smoke.unclamped',
    note: `smoke: ${r.name} is raw-only and made 0 successful calls in ${String(r.calls)}; it needs a clamped handler` }))
}

export function smoke(root: string, fizz: string, meta: string, map: string): Smoked[] {
  const [path, report] = [join(root, 'medusa.json'), join(root, meta, REPORT)]
  const kept = readFileSync(path, 'utf8')
  const config = JSON.parse(kept) as { fuzzing?: object }
  rmSync(report, { force: true })
  writeFileSync(path, JSON.stringify({ ...config, fuzzing: { ...config.fuzzing, revertReporterEnabled: true } }, null, 2))
  let ran: SpawnSyncReturns<string>
  try {
    ran = spawnSync('node', [join(fizz, 'scripts/run_medusa.js'), root, '--meta-dir', meta, '--timeout', SECONDS],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] })
  } finally {
    writeFileSync(path, kept)
  }
  if (!existsSync(report)) throw new Error(`run_medusa.js exited ${String(ran.status)} and wrote no ${report}: ${ran.stderr.slice(-TAIL)}`)
  return smoked(map, report)
}

export const packed = (results: Smoked[]): string =>
  results.map((r) => `- ${r.name} | calls: ${String(r.calls)} | successes: ${String(r.successes)}\n`).join('')
