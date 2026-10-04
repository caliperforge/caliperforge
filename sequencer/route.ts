import { filesOf } from '../store/files.ts'
import type { Db } from '../store/index.ts'
import { internal, planById, type PlanRow } from '../store/plans.ts'
import { FORK, languageOf } from './workspace.ts'
import { homeOf, kernelPlan } from './home.ts'
import { languageOfSeat } from '../templates/pr-path.ts'

/** The manifest entry that says a seat's fence is the file list the brief settled, not a directory. */
export const BRIEF_FILES = 'brief:files'

/**
 * Which builder a plan gets; a part of an outside plan goes by its own files, as the outside plan does. The kernel's own repo is TypeScript; another repo of ours is what its tree is written in, and an empty one goes by the plan's seat unless `bySeat` is false, as for the gates. On a stranger's repo the brief's files decide: all
 * under `kotlin/` is the Kotlin seat; otherwise the files' language,
 * and the outside seat only when no file is in a language with a seat of its own.
 */
export function languageFor(db: Db, plan: PlanRow, src: string, bySeat = true): string | null {
  if (internal(plan) && plan.target_id === null) {
    if (kernelPlan(plan)) return null
    const home = homeOf(plan)
    const own = home in BY_REPO ? majority(filesOf(db, plan.id).map((f) => f.path), home) : null
    return languageOf(src) ?? own ?? (bySeat ? languageOfSeat(plan.seat) : null)
  }
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
  [/\.kts?$/, 'kotlin'],
  [/\.swift$/, 'swift'],
]

/** A file no name rule claims goes by the folder it sits in, as the monorepos we work in lay their SDKs out. */
const BY_FOLDER: [RegExp, string][] = [
  [/^(rust|crates|programs)\//, 'rust'], [/^python\//, 'python'], [/^ruby\//, 'ruby'],
  [/^go\//, 'go'], [/^php\//, 'php'], [/^lua\//, 'lua'],
  [/^kotlin\//, 'kotlin'], [/^swift\//, 'swift'],
]

/** Docs never pick a builder, nor do fixtures a test reads. */
const IGNORED = /\.(md|mdx|txt|rst)$|(^|\/)(docs?|fixtures|testdata)\//

export const TEST = /(^|\/)([Tt]ests?|spec)\/|_test\.(go|rb)$|_spec\.rb$|(^|\/)test_[^/]*\.py$|_test\.py$|Test\.php$|_spec\.lua$/

/** A repo of ours whose files a name rule elsewhere would leave unclaimed. */
const BY_REPO: Record<string, [RegExp, string]> = {
  [`${FORK}/atelier-web`]: [/\.(html|css|m?js)$/, 'web'],
}

/** What one path is written in, or null: a TypeScript file generated beside Rust stays with the Rust. */
export function languageOfPath(path: string, repo = ''): string | null {
  if (IGNORED.test(path)) return null
  const own = BY_REPO[repo]
  if (own?.[0].test(path) === true) return own[1]
  return (BY_NAME.find(([re]) => re.test(path)) ?? BY_FOLDER.find(([re]) => re.test(path)))?.[1] ?? null
}

/** The path a refusal span names: its first word, less a `:N` or `:N-M` line. */
export function pathOfSpan(span: string): string {
  return (span.split(/\s/)[0] ?? '').replace(/:\d+(-\d+)?$/, '')
}

/** What a span's path is written in; TypeScript too, which `languageOfPath` never names. */
export function languageOfSpan(span: string): string | null {
  const path = pathOfSpan(span)
  return languageOfPath(path) ?? (/\.tsx?$/.test(path) && !IGNORED.test(path) ? 'typescript' : null)
}

/** The language with the most non-test files; a list of tests alone counts its tests. A tie goes to the first listed. */
export function majority(paths: string[], repo = ''): string | null {
  const known = paths.map((p) => ({ p, language: languageOfPath(p, repo) })).filter((k): k is { p: string; language: string } => k.language !== null)
  const source = known.filter((k) => !TEST.test(k.p))
  const counted = source.length > 0 ? source : known
  const tally = new Map<string, number>()
  for (const { language } of counted) tally.set(language, (tally.get(language) ?? 0) + 1)
  const top = Math.max(0, ...tally.values())
  return known.find((k) => tally.get(k.language) === top)?.language ?? null
}

/** The paths a seat may write: its manifest's, or the brief's files where the manifest says so or the plan is an outside one. */
export function fenceFor(db: Db, plan: number, writePaths: string[]): string[] {
  const brief = writePaths.includes(BRIEF_FILES) || (writePaths.length > 0 && planById(db, plan).target_id !== null)
  return brief ? filesOf(db, plan).map((f) => f.path) : writePaths
}
