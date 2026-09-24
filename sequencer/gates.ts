import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** A language whose builder holds its own shell and brief-files fence on a stranger's repo (#204). */
export const OUTSIDE_LANGUAGES = ['rust', 'python', 'ruby', 'go', 'php', 'lua'] as const

export type OutsideLanguage = (typeof OUTSIDE_LANGUAGES)[number]

export function outsideLanguage(language: string | null): OutsideLanguage | null {
  return OUTSIDE_LANGUAGES.find((l) => l === language) ?? null
}

export interface Outside {
  language: OutsideLanguage
  /** The brief's files, repo-relative: the first one in the language finds the folder its gates run in. */
  files: string[]
}

export interface Gate {
  script: string
  bin: string
  args: string[]
  /** Repo-relative folder the gate runs in; '' is the checkout's root. */
  dir: string
  quiet?: boolean
}

interface Raw {
  script: string
  bin: string
  args: string[]
  quiet?: boolean
}

interface Recipe {
  /** Files at a folder that make it the language's home. */
  markers: RegExp
  install: Raw | null
  /** Justfile recipes upstream runs as its gates, in order; each is used only when the Justfile defines it. */
  recipes: string[]
  /** What runs where the folder ships no Justfile. */
  raw: Raw[]
}

const RECIPES: Record<Exclude<OutsideLanguage, 'rust'>, Recipe> = {
  python: {
    markers: /^pyproject\.toml$/,
    install: { script: 'install', bin: 'uv', args: ['sync', '--all-extras'] },
    recipes: ['lint', 'typecheck', 'test'],
    raw: [{ script: 'lint', bin: 'uv', args: ['run', '--no-sync', 'ruff', 'check'] }, { script: 'test', bin: 'uv', args: ['run', '--no-sync', 'pytest'] }],
  },
  ruby: {
    markers: /^Gemfile$/,
    install: { script: 'install', bin: 'bundle', args: ['install'] },
    recipes: ['lint', 'test'],
    raw: [{ script: 'test', bin: 'bundle', args: ['exec', 'rake', 'test'] }],
  },
  go: {
    markers: /^go\.mod$/,
    install: null,
    recipes: ['lint', 'test'],
    raw: [
      { script: 'format', bin: 'gofmt', args: ['-s', '-l', '.'], quiet: true },
      { script: 'lint', bin: 'go', args: ['vet', './...'] },
      { script: 'test', bin: 'go', args: ['test', './...'] },
    ],
  },
  php: {
    markers: /^composer\.json$/,
    install: { script: 'install', bin: 'composer', args: ['install', '--no-interaction', '--no-progress'] },
    recipes: ['lint', 'test'],
    raw: [{ script: 'test', bin: 'composer', args: ['test'] }],
  },
  lua: {
    markers: /\.rockspec$/,
    install: null,
    recipes: ['lint', 'test'],
    raw: [{ script: 'lint', bin: 'luacheck', args: ['.'] }, { script: 'test', bin: 'busted', args: [] }],
  },
}

const JUSTFILE = 'Justfile'

/** What step 3 runs on an outside plan: install, then the gates upstream runs, in the language's own folder. */
export function gates(src: string, outside: Outside): Gate[] {
  if (outside.language === 'rust') return rust(src, outside.files)
  const recipe = RECIPES[outside.language]
  const dir = home(src, first(outside), (name) => name === JUSTFILE || recipe.markers.test(name))
  const defined = recipes(join(src, dir, JUSTFILE))
  if (defined === null) return [...(recipe.install === null ? [] : [recipe.install]), ...recipe.raw].map((r) => ({ ...r, dir }))
  const just = (script: string): Gate => ({ script, bin: 'just', args: ['--justfile', JUSTFILE, script], dir })
  const install = defined.has('install') ? [just('install')] : recipe.install === null ? [] : [{ ...recipe.install, dir }]
  return [...install, ...recipe.recipes.filter((r) => defined.has(r)).map(just)]
}

function first(outside: Outside): string {
  return outside.files.find((f) => languageHint(f, outside.language)) ?? outside.files[0] ?? ''
}

const EXT: Record<OutsideLanguage, RegExp> = {
  rust: /\.rs$/, python: /\.py$/, ruby: /\.rb$/, go: /\.go$/, php: /\.php$/, lua: /\.lua$/,
}

function languageHint(path: string, language: OutsideLanguage): boolean {
  return EXT[language].test(path) || path.startsWith(`${language}/`)
}

/** The nearest folder at or above the file's own that holds a marker; the root when none does. */
function home(src: string, file: string, marks: (name: string) => boolean): string {
  let dir = dirname(file)
  for (;;) {
    const here = join(src, dir === '.' ? '' : dir)
    if (existsSync(here) && readdirSync(here).some(marks)) return dir === '.' ? '' : dir
    if (dir === '.' || dir === '') return ''
    dir = dirname(dir)
  }
}

/** A Justfile's recipe names, or null when there is none. */
export function recipes(path: string): Set<string> | null {
  if (!existsSync(path)) return null
  const names = [...readFileSync(path, 'utf8').matchAll(/^@?([A-Za-z_][\w-]*)(?:[ \t][^:\n]*)?:(?!=)/gm)].map((m) => m[1] ?? '')
  return new Set(names)
}

/**
 * #192: the format check their CI runs, read off `.github/workflows`, at the workspace root; then the tests of
 * the crates the brief touches, never the whole workspace, which on surfpool is minutes of build.
 */
function rust(src: string, files: string[]): Gate[] {
  const own = files.filter((f) => f.endsWith('.rs'))
  const root = workspace(src, own[0] ?? files[0] ?? '')
  const crates = [...new Set(own.map((f) => crate(src, f)).filter((c): c is string => c !== null))]
  return [
    { script: 'format', bin: 'cargo', args: formatLine(src), dir: root },
    { script: 'test', bin: 'cargo', args: ['test', ...crates.flatMap((c) => ['-p', c])], dir: root },
  ]
}

const FMT = /\bcargo((?:[ \t]+\+[\w.-]+)?[ \t]+fmt\b[^\n'"#]*)/

export function formatLine(src: string): string[] {
  const dir = join(src, '.github', 'workflows')
  const found = existsSync(dir)
    ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => FMT.exec(readFileSync(join(dir, f), 'utf8'))?.[1])
      .find((line) => line?.includes('--check') === true)
    : undefined
  return found === undefined ? ['fmt', '--all', '--', '--check'] : found.trim().split(/\s+/)
}

/** The topmost folder on the file's path that holds a Cargo.toml: `cargo fmt --all` reads the whole workspace from there. */
function workspace(src: string, file: string): string {
  let found = ''
  let dir = dirname(file)
  for (;;) {
    const rel = dir === '.' ? '' : dir
    if (existsSync(join(src, rel, 'Cargo.toml'))) found = rel
    if (rel === '') return found
    dir = dirname(dir)
  }
}

/** The package the file compiles in: the nearest Cargo.toml above it that names one. */
function crate(src: string, file: string): string | null {
  let dir = dirname(file)
  for (;;) {
    const rel = dir === '.' ? '' : dir
    const path = join(src, rel, 'Cargo.toml')
    const name = existsSync(path) ? /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/m.exec(readFileSync(path, 'utf8'))?.[1] : undefined
    if (name !== undefined) return name
    if (rel === '') return null
    dir = dirname(dir)
  }
}
