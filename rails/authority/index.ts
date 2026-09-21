import { createHash } from 'node:crypto'
import { parse } from '../diff.ts'
import type { Verdict } from '../record.ts'
import { refuse } from '../../runner/index.ts'
import { seat } from '../../runner/rules.ts'

const FROZEN = /^schema\/000[12]/

/**
 * #41: the rail judges the finished diff with the same write rule the runner enforced while it was
 * being written (`runner/index.ts:refuse`). With `ours` -- a plan filed from one of our own issues
 * -- a kernel build may touch the whole kernel, so the only refusals left are `.cf/` (the tick's own
 * notes) and the frozen migrations. Without it the manifest's `write_paths` stand, unchanged: that
 * is the narrow fence a counterparty never agreed to widen. `outside` is what a kernel build touched
 * beyond its brief's file list (#87), and `renumbered` the migrations it created under a number the
 * checkout already holds (both `sequencer/fence.ts`).
 */
export function authority(root: string, name: string, diff: string, ours = false,
  writePaths: string[] = seat(root, name).manifest.write_paths, outside: string[] = [], renumbered: string[] = []): Verdict {
  const fence = ours ? 'our own tree (all but `.cf/`)' : `seat "${name}" write_paths (${writePaths.join(', ')})`
  const files = parse(diff)
  const spans = files.flatMap((f) => {
    if (FROZEN.test(f.path)) return [`${f.path}:1 authority.frozen_schema`]
    return refuse(root, writePaths, f.path, ours) === null ? [] : [`${f.path}:1 authority.write_paths`]
  })
  spans.push(...outside.filter((p) => !spans.some((s) => s.startsWith(`${p}:`))).map((p) => `${p}:1 authority.outside_files`))
  spans.push(...renumbered.map((p) => `${p}:1 authority.schema_number`))
  const subject_digest = createHash('sha256').update(diff).digest('hex')
  if (spans.length === 0) return { outcome: 'pass', defect_class: null, origin_kind: null, origin_ref: null, subject_digest, spans, message: `${String(files.length)} file(s) inside ${fence}` }
  return {
    outcome: 'refuse', defect_class: null,
    origin_kind: 'rail',
    origin_ref: 'authority',
    subject_digest,
    spans,
    message: `${String(spans.length)} span(s) outside ${fence}, under a frozen migration, outside the brief's file list with no row under ## Outside the files, or a new migration numbered at or below one the checkout holds`,
  }
}
