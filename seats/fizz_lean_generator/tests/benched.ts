import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fresh } from '../../../checks/sqlite.ts'
import type { Fired, Packet, Provider } from '../../../providers/kind.ts'
import { load, seat } from '../../../runner/rules.ts'
import { mapOf } from '../../../sequencer/steps.ts'
import { planDir } from '../../../sequencer/workspace.ts'
import { pipeNamed, planById, putPlan } from '../../../store/plans.ts'
import { CEILING } from '../../../templates/bench.ts'
import type { Refused } from '../../../templates/handoff.ts'
import { phased } from '../../../templates/phases.ts'

const repo = join(import.meta.dirname, '../../..')
const { manifest, hash } = seat(repo, 'fizz_lean_generator')
const ROOT = mkdtempSync(join(tmpdir(), 'cf-fizz-bench-'))
const WALLS = { usd: 100, input: 0, cache_write: 0, cache_write_1h: 0, cache_read: 0, output: 0 }
const PHASE = /step-\d+-([\w-]+)\.pending/

export const transcripts = (n: number): string[] => [...Array(n).keys()].map((i) => join(planDir(ROOT, 1), `run-${String(i + 1)}.transcript.jsonl`))

/** A bench plan whose provider hands each packet and its phase to `fire`, and completes with what `fire` returns on top. */
export function benched(fire: (packet: Packet, phase: string) => Partial<Fired>, granted: string[] = []) {
  const db = fresh(join(repo, 'schema'))
  load(db, repo)
  putPlan(db, { id: 1, pipe_id: Number(pipeNamed(db, 'bench')?.id), target_id: null, template: 'bench', state: 'queued', queued_at: '2026-11-02T00:00:00.000Z', step: 1, retries: 0 })
  const provider: Provider = { name: 'claude-agent-sdk', fire: (packet) => Promise.resolve({ text: '', transcript_path: packet.transcript, usage: { input: 0, cache: 0, output: 1 },
    seconds: 0, ended: 'completed', exit: 0, stop_reason: null, denials: 0, ...fire(packet, PHASE.exec(packet.transcript)?.[1] ?? '') }) }
  const bench = { db, root: ROOT, plan: planById(db, 1), step: mapOf('bench').at(1), provider, name: 'fizz_lean_generator', dir: ROOT, tmp: ROOT, granted, walls: WALLS, ceiling: CEILING }
  return { db, root: ROOT, run: (skill: string, handoffs: string, critics: () => Refused[], stop?: string) => phased(bench, manifest, hash, skill, handoffs, 'Generate.', critics, stop) }
}
