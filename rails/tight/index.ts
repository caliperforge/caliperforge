import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { manifest } from '../../checks/manifest.ts'
import { parse, type FileDiff } from '../diff.ts'
import type { Verdict } from '../record.ts'
import { scan, type Declaration } from './braces.ts'
import { inProse } from './prose.ts'
import { inSource, type Ceilings, type Span } from './source.ts'

const BRACED = ['.kt', '.kts', '.swift']
const HISTORY = '; history belongs in the commit message, the comment keeps the one sentence that states the rule'

export interface Subject {
  diff: string
  sources: Record<string, string>
  description: string
  /** What a prose span is named for: the PR text, or the builder's handback where there is none. */
  prose?: 'description' | 'handback'
  /** False on someone else's repo: their format and lint checks set the code's limits, and only the prose is ours. */
  code?: boolean
}

export function tight(root: string, subject: Subject): Verdict {
  const { ceilings } = manifest(root)
  const files = parse(subject.diff)
  const judged = subject.code === false ? [] : files
  const spans = [
    ...judged.flatMap((f) => named(f.path, inFile(f, subject.sources, ceilings))),
    ...named(subject.prose ?? 'description', inProse(subject.description, files.map((f) => f.path))),
  ]
  const unread = noted(judged.filter((f) => unbalanced(f, subject.sources)).map((f) => f.path))
  const subject_digest = createHash('sha256').update(`${subject.diff}\n${subject.description}`).digest('hex')
  if (spans.length === 0) return { outcome: 'pass', defect_class: null, origin_kind: null, origin_ref: null, subject_digest, spans, message: `${String(files.length)} file(s) and the description are Tight${unread}` }
  return {
    outcome: 'refuse', defect_class: null,
    origin_kind: 'rail',
    origin_ref: 'tight',
    subject_digest,
    spans,
    message: `${String(spans.length)} span(s) breach Tight at function_lines ${String(ceilings.function_lines)}, nesting ${String(ceilings.nesting)}${unread}${spans.some((s) => s.endsWith(' tight.history')) ? HISTORY : ''}`,
  }
}

/** The brace scanner judges length and nesting only; unused declarations and comments stay TypeScript-only. */
function inFile(file: FileDiff, sources: Record<string, string>, ceilings: Ceilings): Span[] {
  const text = sources[file.path]
  if (text === undefined) return []
  const added = new Set(file.added.map((l) => l.line))
  if (file.path.endsWith('.ts')) return inSource(text, added, ceilings)
  if (!braced(file.path)) return []
  const { declarations, balanced } = scan(text)
  if (!balanced) return []
  return declarations.filter((d) => !d.expression && touched(d, added)).flatMap((d) => judge(d, ceilings))
}

function braced(path: string): boolean {
  return BRACED.some((extension) => path.endsWith(extension))
}

function unbalanced(file: FileDiff, sources: Record<string, string>): boolean {
  const text = sources[file.path]
  return text !== undefined && braced(file.path) && !scan(text).balanced
}

function touched(d: Declaration, added: Set<number>): boolean {
  return [...added].some((l) => l >= d.line && l <= d.end)
}

function judge(d: Declaration, ceilings: Ceilings): Span[] {
  return [
    ...(d.end - d.line + 1 > ceilings.function_lines ? [{ line: d.line, kind: 'tight.length' }] : []),
    ...(d.nesting > ceilings.nesting ? [{ line: d.line, kind: 'tight.nesting' }] : []),
  ]
}

function noted(paths: string[]): string {
  return paths.length === 0 ? '' : `; unbalanced braces left ${paths.join(', ')} unread`
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
