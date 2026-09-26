import { existsSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Db } from './index.ts'

/** The name a provider writes under before the run it belongs to has an id. */
export function pending(dir: string, tag: string): string {
  return join(dir, `${tag}.pending.transcript.jsonl`)
}

/**
 * A transcript is named for its run. A retry repeats the step, so a name built
 * from the step overwrites the file an earlier `runs` row still points at; the
 * id is unique, and it exists only once the row is inserted.
 */
export function byRun(db: Db, run: number, written: string): string {
  const named = join(dirname(written), `run-${String(run)}.transcript.jsonl`)
  if (existsSync(written)) renameSync(written, named)
  db.prepare('UPDATE runs SET transcript_path = ? WHERE id = ?').run(named, run)
  return named
}

const FIGURE = /"total_cost_usd":(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/

/** A message and its newline are appended in one write, so only the text after the last newline can be cut short. */
export function cost(path: string): number | null {
  if (!existsSync(path)) return null
  for (const line of readFileSync(path, 'utf8').split('\n').slice(0, -1).reverse()) {
    const figure = FIGURE.exec(line)?.[1]
    if (figure !== undefined) return Number(figure)
  }
  return null
}

export function backfill(db: Db): number {
  const rows = db.prepare('SELECT id, transcript_path FROM runs WHERE cost_usd IS NULL').all() as { id: number; transcript_path: string }[]
  const write = db.prepare('UPDATE runs SET cost_usd = ? WHERE id = ? AND cost_usd IS NULL')
  let written = 0
  for (const row of rows) {
    const figure = cost(row.transcript_path)
    if (figure !== null) written += write.run(figure, row.id).changes
  }
  return written
}
