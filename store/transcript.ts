import { existsSync, renameSync } from 'node:fs'
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
