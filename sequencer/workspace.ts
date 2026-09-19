import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** The plan's scratch checkout. No `plans/` segment: `runner/packet.ts:admits()` bars one from a reviewer cwd. */
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

export function drop(root: string, plan: number, name: string): void {
  rmSync(join(planDir(root, plan), name), { force: true })
}

export function move(root: string, plan: number, from: string, to: string): string {
  const body = get(root, plan, from)
  put(root, plan, to, body)
  rmSync(join(planDir(root, plan), from))
  return body
}

export function doneIds(issue: string): string[] {
  const ids = [...issue.matchAll(/^\s*[-*]\s*\**(D\d+)\**/gm)].map((m) => m[1] ?? '')
  return ids.length === 0 ? ['D1'] : [...new Set(ids)]
}

/** The org account every target is forked into. A branch is pushed here; it is never cut from here. */
export const FORK = 'caliperforge'

/** Our own repository: the tree an internal plan is branched in, and the one its PR is opened on. */
export const SELF = `${FORK}/caliperforge`

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

/** The branch an internal plan works on: the plan number, then the issue title as a slug. */
export function internalBranch(plan: number, title: string): string {
  return `p${String(plan)}-${slugged(title)}`
}

function slugged(title: string): string {
  const cut = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48).replace(/^-+|-+$/g, '')
  return cut === '' ? 'issue' : cut
}

/** The ticket's title: the first heading of the brief, or of the ask the plan was filed with before there is one. */
export function titleOf(root: string, plan: number): string | null {
  const body = maybe(root, plan, 'issue.md') ?? maybe(root, plan, 'ask.md')
  return body === null ? null : (/^#\s+(.*)$/m.exec(body)?.[1]?.trim() ?? null)
}

export function gitBase(root: string): string {
  const path = join(root, '.cf/git-base')
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : 'https://github.com'
}

function remote(base: string, slug: string): string {
  return base.includes('://') ? `${base}/${slug}.git` : join(base, slug)
}

/**
 * The ref a tree is cut from and landed on. An internal plan's `origin` and `upstream` are the same
 * repository -- ours -- so for one of our own plans this ref is `origin/main` exactly; for a target
 * it is the stranger's `main`, which our fork may sit behind.
 */
export const MAIN = 'refs/remotes/upstream/main'

/** #35 rule 2: main is re-read before a tree is cut and before a base is judged, so nothing starts from a stale ref. */
export function fetchMain(dir: string): string {
  git(dir, ['fetch', '--no-tags', 'origin', '+main:refs/remotes/origin/main'])
  git(dir, ['fetch', '--no-tags', 'upstream', `+main:${MAIN}`])
  return git(dir, ['rev-parse', MAIN]).trim()
}

/** Whether the branch was cut from a `main` that has since moved on without it. */
export function behindMain(dir: string): boolean {
  const main = git(dir, ['rev-parse', MAIN]).trim()
  return git(dir, ['merge-base', 'HEAD', MAIN]).trim() !== main
}

export function mergeMain(dir: string): void {
  git(dir, ['-c', 'user.email=cf@caliperforge.dev', '-c', 'user.name=caliperforge',
    'merge', '--no-edit', MAIN])
}

/**
 * A merge that could not be made leaves no trace. `merge --abort` restores the tree; when git refused
 * before it touched a file there is no merge to abort and the throw is the proof the tree is already clean.
 */
export function abortMerge(dir: string): void {
  try {
    git(dir, ['merge', '--abort'])
  } catch {
    return
  }
}

/** Unmerged paths: a tree a tick stopped mid-merge in. Nothing is committed, signed or landed from one. */
export function conflicted(dir: string): boolean {
  return git(dir, ['diff', '--name-only', '--diff-filter=U']).trim() !== ''
}

/**
 * #35 rule 2: the live kernel tree is the machine's, not a seat's. Every seat and reviewer works in
 * `.cf/work/<plan>/src`, so a cwd under the root that is not one is the tree the tick itself runs from.
 */
export function liveTree(root: string, cwd: string): boolean {
  const rel = relative(resolve(root), resolve(cwd))
  if (rel.startsWith('..')) return false
  return !/^\.cf[/\\]work[/\\]\d+[/\\]src([/\\]|$)/.test(rel)
}

/**
 * `--no-local`: a hardlinked clone shares an object store with its source, and the builder must not reach back through it.
 * `core.hooksPath` is set here and not at step 8, so every push out of a plan checkout meets the pre-push hook, not just the kernel's.
 */
export function checkout(root: string, plan: number, repo: string, branch: string): Checkout {
  const dir = srcDir(root, plan)
  const done = maybe(root, plan, 'base.sha')
  if (done !== null && cloned(dir)) { fetchMain(dir); return { dir, branch, base: done.trim() } }
  const base = gitBase(root)
  git(planDir(root, plan), ['clone', '--no-local', '--origin', 'origin',
    '-c', `remote.upstream.url=${remote(base, repo)}`,
    '-c', 'remote.upstream.fetch=+refs/heads/*:refs/remotes/upstream/*',
    remote(base, `${FORK}/${repoName(repo)}`), dir])
  git(dir, ['config', 'core.hooksPath', join(root, 'hooks')])
  const head = fetchMain(dir)
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

/** The tree as a reviewer saw it, named by a sha nothing commits: what a later round diffs against. */
export function snapshot(dir: string): string {
  git(dir, ['add', '-A'])
  return git(dir, ['write-tree']).trim()
}

export function diffSince(dir: string, tree: string): string {
  git(dir, ['add', '-A', '--intent-to-add'])
  return git(dir, ['diff', tree])
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}

/** Without a real checkout the workspace starts empty, so every file in it is an addition. */
export function diffOf(root: string, plan: number): string {
  const src = srcDir(root, plan)
  const base = maybe(root, plan, 'base.sha')
  if (base !== null && cloned(src)) return gitDiff(src, base.trim())
  return additions(src)
}

function additions(src: string): string {
  return files(src).map((path) => {
    const body = readFileSync(path, 'utf8')
    const lines = body.split('\n')
    const rel = relative(src, path)
    return `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${String(lines.length)} @@\n${lines.map((l) => `+${l}`).join('\n')}`
  }).join('\n')
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)])
}
