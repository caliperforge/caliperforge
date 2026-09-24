import { filesOf } from '../store/files.ts'
import type { Db } from '../store/index.ts'
import { internal, type PlanRow } from '../store/plans.ts'
import { languageOf } from './workspace.ts'
import { kernelPlan } from './home.ts'

/** The manifest entry that says a seat's fence is the file list the brief settled, not a directory. */
export const BRIEF_FILES = 'brief:files'

/**
 * Which builder a plan gets. The kernel's own repo is TypeScript; another repo of ours is what its tree is written in (#69). On a stranger's repo the brief's files decide: all
 * under `kotlin/` is the Kotlin seat, whose fence is that folder; otherwise the files' language (#204),
 * and the outside seat only when no file is in a language with a seat of its own.
 */
export function languageFor(db: Db, plan: PlanRow, src: string): string | null {
  if (internal(plan)) return kernelPlan(plan) ? null : languageOf(src)
  const paths = filesOf(db, plan.id).map((f) => f.path)
  if (paths.length === 0) return languageOf(src)
  if (paths.every((p) => p.startsWith('kotlin/'))) return 'kotlin'
  return majority(paths) ?? OUTSIDE
}

export const OUTSIDE = 'outside'

const BY_NAME: [RegExp, string][] = [
  [/\.rs$|(^|\/)Cargo\.toml$/, 'rust'],
  [/\.pyi?$|(^|\/)(pyproject\.toml|uv\.lock)$/, 'python'],
  [/\.(rb|gemspec|rake)$|(^|\/)(Gemfile|Rakefile)$/, 'ruby'],
  [/\.go$|(^|\/)go\.(mod|sum)$/, 'go'],
  [/\.php$|(^|\/)composer\.json$/, 'php'],
  [/\.lua$|\.rockspec$|(^|\/)\.luacheckrc$/, 'lua'],
]

/** A file no name rule claims goes by the folder it sits in, as the monorepos we work in lay their SDKs out. */
const BY_FOLDER: [RegExp, string][] = [
  [/^(rust|crates|programs)\//, 'rust'], [/^python\//, 'python'], [/^ruby\//, 'ruby'],
  [/^go\//, 'go'], [/^php\//, 'php'], [/^lua\//, 'lua'],
]

/** Docs never pick a builder, nor do fixtures a test reads. */
const IGNORED = /\.(md|mdx|txt|rst)$|(^|\/)(docs?|fixtures|testdata)\//

const TEST = /(^|\/)(tests?|spec)\/|_test\.(go|rb)$|_spec\.rb$|(^|\/)test_[^/]*\.py$|_test\.py$|Test\.php$|_spec\.lua$/

/** What one path is written in, or null: a TypeScript file generated beside Rust stays with the Rust. */
export function languageOfPath(path: string): string | null {
  if (IGNORED.test(path)) return null
  return (BY_NAME.find(([re]) => re.test(path)) ?? BY_FOLDER.find(([re]) => re.test(path)))?.[1] ?? null
}

/** The language with the most non-test files; a list of tests alone counts its tests. A tie goes to the first listed. */
export function majority(paths: string[]): string | null {
  const known = paths.map((p) => ({ p, language: languageOfPath(p) })).filter((k): k is { p: string; language: string } => k.language !== null)
  const source = known.filter((k) => !TEST.test(k.p))
  const counted = source.length > 0 ? source : known
  const tally = new Map<string, number>()
  for (const { language } of counted) tally.set(language, (tally.get(language) ?? 0) + 1)
  const top = Math.max(0, ...tally.values())
  return known.find((k) => tally.get(k.language) === top)?.language ?? null
}

/** The paths a seat may write: its manifest's, or the brief's files where the manifest says so. */
export function fenceFor(db: Db, plan: number, writePaths: string[]): string[] {
  return writePaths.includes(BRIEF_FILES) ? filesOf(db, plan).map((f) => f.path) : writePaths
}
