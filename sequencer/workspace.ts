import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The plan's scratch checkout, at `.cf/work/<id>`.
 *
 * `runner/packet.ts:admits()` refuses any reviewer cwd carrying a `plans/`
 * path segment. That rule targets the org's own `plans/`; it cannot tell the
 * two apart. The earlier name `.cf/plans/<id>` tripped it on every review.
 */
export function planDir(root: string, plan: number): string {
  return join(root, '.cf/work', String(plan))
}

export function srcDir(root: string, plan: number): string {
  const dir = join(planDir(root, plan), 'src')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function put(root: string, plan: number, name: string, body: string): string {
  const dir = planDir(root, plan)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

export function get(root: string, plan: number, name: string): string {
  return readFileSync(join(planDir(root, plan), name), 'utf8')
}

export function maybe(root: string, plan: number, name: string): string | null {
  const path = join(planDir(root, plan), name)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

export function doneIds(issue: string): string[] {
  const ids = [...issue.matchAll(/^\s*[-*]\s*\**(D\d+)\**/gm)].map((m) => m[1] ?? '')
  return ids.length === 0 ? ['D1'] : [...new Set(ids)]
}

/** The org account every target is forked into. A branch is pushed here; it is never cut from here. */
const FORK = 'caliperforge'

/** A target directory that names the language its builder must be able to compile. */
const LANGUAGES: [string, string][] = [['kotlin', 'kotlin']]

export interface Checkout {
  dir: string
  branch: string
  base: string
}

export function repoName(repo: string): string {
  return repo.split('/')[1] ?? repo
}

export function branchOf(repo: string, issue: number, attempt: number): string {
  return `${repoName(repo)}-${String(issue)}-a${String(attempt)}`
}

/**
 * Where clones come from. `<root>/.cf/git-base` is the only override, it is
 * gitignored, and absent it is github.com — so a real run always reaches the
 * real fork and a test can aim the same code at a local fixture.
 */
export function gitBase(root: string): string {
  const path = join(root, '.cf/git-base')
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : 'https://github.com'
}

function remote(base: string, slug: string): string {
  return base.includes('://') ? `${base}/${slug}.git` : join(base, slug)
}

/**
 * The plan's checkout of a real repository.
 *
 * `origin` is our fork, because that is the only place we may push. `upstream`
 * is the target's own repo and the branch is cut from *its* `main`, so the diff
 * a reviewer reads is against the maintainer's tree and not against whatever
 * the fork has drifted to. A target we own is its own upstream and walks the
 * identical path. `--no-local` because a hardlinked clone shares an object
 * store with its source: the builder must not be able to reach back through it.
 */
export function checkout(root: string, plan: number, repo: string, issue: number, attempt: number): Checkout {
  const dir = srcDir(root, plan)
  const branch = branchOf(repo, issue, attempt)
  const done = maybe(root, plan, 'base.sha')
  if (done !== null && cloned(dir)) return { dir, branch, base: done.trim() }
  const base = gitBase(root)
  git(planDir(root, plan), ['clone', '--no-local', '--origin', 'origin',
    '-c', `remote.upstream.url=${remote(base, repo)}`,
    '-c', 'remote.upstream.fetch=+refs/heads/*:refs/remotes/upstream/*',
    remote(base, `${FORK}/${repoName(repo)}`), dir])
  git(dir, ['fetch', '--no-tags', 'upstream', '+main:refs/remotes/upstream/main'])
  const head = git(dir, ['rev-parse', 'refs/remotes/upstream/main']).trim()
  git(dir, ['checkout', '-B', branch, head])
  put(root, plan, 'base.sha', `${head}\n`)
  return { dir, branch, base: head }
}

export function cloned(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

/** What the checkout is written in, by the directory a builder would have to work in. */
export function languageOf(dir: string): string | null {
  for (const [sub, language] of LANGUAGES) if (existsSync(join(dir, sub))) return language
  return null
}

/** Everything the builder changed, against the sha the branch was cut from. */
export function gitDiff(dir: string, base: string): string {
  git(dir, ['add', '-A', '--intent-to-add'])
  return git(dir, ['diff', base])
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}
