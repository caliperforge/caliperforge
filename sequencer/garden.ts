import { counts, FIX, METRICS, type Counts } from '../checks/ratchet.ts'
import { LANE } from '../cli/plan.ts'
import { gardened, idle, openGardens, record } from '../store/gardens.ts'
import type { Db } from '../store/index.ts'
import { hhmm } from '../store/lanes.ts'
import { openPipes } from '../store/plans.ts'
import { SELF } from './workspace.ts'

type File = (repo: string, title: string, body: string, labels: string[]) => string

type Metric = typeof METRICS[number]

export function garden(db: Db, root: string, now: Date, file: File): string | null {
  const day = now.toISOString().slice(0, 10)
  const pipe = openPipes(db, hhmm(db, now)).find((p) => p.name === LANE.machine.pipe)
  if (pipe === undefined || !idle(db, pipe) || gardened(db, day) || openGardens(db) >= 2) return null
  const tally = counts(root)
  const [metric, total] = worst(tally)
  if (total === 0) return null
  const top = Object.entries(tally).map(([path, t]) => [path, t[metric] ?? 0] as const)
    .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5)
  const body = [`**What:** lower ${metric} in ${top.map(([path]) => path).join(', ')}: ${FIX[metric]}`,
    `**Why:** cf health counts ${String(total)} ${metric}`,
    `**When it ends:** cf health shows ${metric} at most ${String(total - sum(top.map(([, n]) => n)))}`, ''].join('\n')
  const url = file(SELF, `Gardener: lower ${metric} in ${String(top.length)} files`, body, ['lane:machine', 'P3'])
  record(db, day, metric, url)
  return url
}

function worst(tally: Counts): [Metric, number] {
  return METRICS.filter((m) => m !== 'lines')
    .map((m): [Metric, number] => [m, sum(Object.values(tally).map((t) => t[m] ?? 0))])
    .reduce((best, next) => next[1] > best[1] ? next : best)
}

function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0)
}
