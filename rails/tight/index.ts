import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { manifest } from '../../checks/manifest.ts'
import { parse, type FileDiff } from '../diff.ts'
import type { Verdict } from '../record.ts'
import { inProse } from './prose.ts'
import { inSource, type Ceilings, type Span } from './source.ts'

export interface Subject {
  diff: string
  sources: Record<string, string>
  description: string
  /** What a prose span is named for: the PR text, or the builder's handback where there is none. */
  prose?: 'description' | 'handback'
}

export function tight(root: string, subject: Subject): Verdict {
  const { ceilings } = manifest(root)
  const files = parse(subject.diff)
  const spans = [
    ...files.flatMap((f) => named(f.path, inFile(f, subject.sources, ceilings))),
    ...named(subject.prose ?? 'description', inProse(subject.description, files.map((f) => f.path))),
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

/** Tight reads the whole function a hunk lands in, so it needs each changed file as the checkout now holds it. */
export function sources(dir: string, diff: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const file of parse(diff)) {
    const path = join(dir, file.path)
    if (file.deleted || !file.path.endsWith('.ts') || !existsSync(path)) continue
    out[file.path] = readFileSync(path, 'utf8')
  }
  return out
}

/** The ref a checkout is judged against: upstream main in a plan checkout, origin main in any other clone. */
const BASES = ['refs/remotes/upstream/main', 'refs/remotes/origin/main']

/** The rail as step 3 runs it, on the working tree against where it was cut, so a builder can run it before handing back. */
export function self(dir: string): Verdict {
  const base = BASES.find((ref) => resolves(dir, ref))
  if (base === undefined) throw new Error('no main to diff against')
  git(dir, ['add', '-A', '--intent-to-add'])
  const diff = git(dir, ['diff', git(dir, ['merge-base', 'HEAD', base]).trim()])
  return tight(dir, { diff, sources: sources(dir, diff), description: '' })
}

function resolves(dir: string, ref: string): boolean {
  try {
    git(dir, ['rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}
