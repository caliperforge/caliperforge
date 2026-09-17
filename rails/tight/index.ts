import { createHash } from 'node:crypto'
import { manifest } from '../../checks/manifest.ts'
import { parse, type FileDiff } from '../diff.ts'
import type { Verdict } from '../record.ts'
import { inProse } from './prose.ts'
import { inSource, type Ceilings, type Span } from './source.ts'

export interface Subject {
  diff: string
  sources: Record<string, string>
  description: string
}

export function tight(root: string, subject: Subject): Verdict {
  const { ceilings } = manifest(root)
  const files = parse(subject.diff)
  const spans = [
    ...files.flatMap((f) => named(f.path, inFile(f, subject.sources, ceilings))),
    ...named('description', inProse(subject.description, files.map((f) => f.path))),
  ]
  const subject_digest = createHash('sha256').update(`${subject.diff}\n${subject.description}`).digest('hex')
  if (spans.length === 0) return { outcome: 'pass', defect_class: null, origin_kind: null, origin_ref: null, subject_digest, spans, message: `${String(files.length)} file(s) and the description are Tight` }
  return {
    outcome: 'refuse', defect_class: null,
    origin_kind: 'rail',
    origin_ref: 'tight',
    subject_digest,
    spans,
    message: `${String(spans.length)} span(s) breach Tight at function_lines ${String(ceilings.function_lines)}, nesting ${String(ceilings.nesting)}`,
  }
}

function inFile(file: FileDiff, sources: Record<string, string>, ceilings: Ceilings): Span[] {
  const text = sources[file.path]
  if (text === undefined || !file.path.endsWith('.ts')) return []
  return inSource(text, new Set(file.added.map((l) => l.line)), ceilings)
}

function named(path: string, spans: Span[]): string[] {
  return spans.map((s) => `${path}:${String(s.line)} ${s.kind}`)
}
