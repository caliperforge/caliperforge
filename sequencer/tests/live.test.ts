import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { planById, putPlan, type PlanRow } from '../../store/plans.ts'
import type { npm } from '../checks.ts'
import { live } from '../live.ts'
import { maybe, srcDir } from '../workspace.ts'

const GATED = 'tools/a.test.ts'

const PLAIN = 'tools/b.test.ts'

const edit = (path: string): string => `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n+x\n`

const DIFF = edit(GATED) + edit(PLAIN) + edit('sequencer/live.ts')

function kernel(): { root: string; plan: PlanRow } {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  putPlan(db, { id: 1, pipe_id: 1, target_id: null, template: 'pr_path', state: 'running', queued_at: '2026-10-31', step: 0, retries: 0,
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/1' })
  const root = mkdtempSync(join(tmpdir(), 'cf-live-'))
  const src = srcDir(root, 1)
  mkdirSync(join(src, 'tools'))
  writeFileSync(join(src, GATED), "test.runIf(process.env.CF_BENCH_LIVE === '1')('x', () => {})\n")
  writeFileSync(join(src, PLAIN), "test('x', () => {})\n")
  return { root, plan: planById(db, 1) }
}

function fake(): { run: typeof npm; calls: Parameters<typeof npm>[] } {
  const calls: Parameters<typeof npm>[] = []
  return { calls, run: (...args) => { calls.push(args); return { ok: true, output: 'green' } } }
}

const sha = (diff: string): string => createHash('sha256').update(diff).digest('hex')

test('D1 a gated test file runs live on the checkout', () => {
  const { root, plan } = kernel()
  const { run, calls } = fake()
  live(root, plan, DIFF, run)
  expect(calls).toEqual([[['exec', '--', 'vitest', 'run', GATED], srcDir(root, 1), 'npm', 60 * 60 * 1000, undefined, { CF_BENCH_LIVE: '1' }]])
  expect(maybe(root, 1, 'live.md')).toBe(`${sha(DIFF)}\npass\nCF_BENCH_LIVE=1 npm exec -- vitest run ${GATED}\ngreen`)
})

test('D4 the same diff runs once; a changed one runs again', () => {
  const { root, plan } = kernel()
  const { run, calls } = fake()
  live(root, plan, DIFF, run)
  live(root, plan, DIFF, run)
  expect(calls).toHaveLength(1)
  live(root, plan, `${DIFF}+y\n`, run)
  expect(calls).toHaveLength(2)
  expect(maybe(root, 1, 'live.md')?.split('\n')[0]).toBe(sha(`${DIFF}+y\n`))
})

test('D5 no kernel plan, no gated file or a deleted one: no run', () => {
  const { root, plan } = kernel()
  const { run, calls } = fake()
  live(root, { ...plan, origin: 'https://github.com/acme/kit/issues/1' }, DIFF, run)
  live(root, { ...plan, target_id: 1 }, DIFF, run)
  live(root, plan, edit(PLAIN), run)
  live(root, plan, `--- a/${GATED}\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n`, run)
  expect(calls).toEqual([])
  expect(maybe(root, 1, 'live.md')).toBeNull()
})
