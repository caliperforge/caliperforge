import { createHash } from 'node:crypto'
import { parse } from '../diff.ts'
import type { Verdict } from '../record.ts'
import { refuse } from '../../runner/index.ts'
import { seat } from '../../runner/rules.ts'

const FROZEN = /^schema\/000[12]/

export function authority(root: string, name: string, diff: string): Verdict {
  const writePaths = seat(root, name).manifest.write_paths
  const files = parse(diff)
  const spans = files.flatMap((f) => {
    if (FROZEN.test(f.path)) return [`${f.path}:1 authority.frozen_schema`]
    return refuse(root, writePaths, f.path) === null ? [] : [`${f.path}:1 authority.write_paths`]
  })
  const subject_digest = createHash('sha256').update(diff).digest('hex')
  if (spans.length === 0) return { outcome: 'pass', defect_class: null, origin_kind: null, origin_ref: null, subject_digest, spans, message: `${String(files.length)} file(s) inside ${writePaths.join(', ')}` }
  return {
    outcome: 'refuse', defect_class: null,
    origin_kind: 'rail',
    origin_ref: 'authority',
    subject_digest,
    spans,
    message: `${String(spans.length)} span(s) outside seat "${name}" write_paths or under a frozen migration`,
  }
}
