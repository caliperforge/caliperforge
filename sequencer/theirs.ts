import { statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { gh, mentions, ours, WINDOW, type Read } from '../cli/gh.ts'
import { unhoused } from '../cli/queue.ts'
import { parse } from '../rails/diff.ts'
import type { Check, Target } from './card.ts'
import { coded } from './size.ts'
import { diffOf, git, MAIN, maybe, srcDir } from './workspace.ts'

const Login = z.object({ login: z.string() })

const Prs = z.array(z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  body: z.string(),
  isDraft: z.boolean(),
  author: Login.nullable(),
  headRepositoryOwner: Login.nullable(),
  files: z.array(z.object({ path: z.string() })),
}))

const Siblings = z.array(z.object({ url: z.string(), repository: z.object({ nameWithOwner: z.string() }) }))

const Patches = z.array(z.object({ filename: z.string(), patch: z.string().optional() }))

const RECENT = 30

type Paths = (root: string, plan: number) => string[]

/** Whether any of `files` has a hunk context in both our diff and the hunks `of` reads for it. */
type Same = (files: string[], of: (path: string) => string) => boolean

interface Found { says: string; files: string[] }

export interface Hit { url: string; says: string; files: string[]; same: boolean; code: boolean }

export function theirs(read: Read = gh, paths: Paths = diffed): Check {
  return (...[, root, plan, target]) => {
    const hits = work(read, root, plan, target, paths).map((h) => h.says).sort()
    return { check: 'their work', ok: hits.length === 0,
      says: hits.length === 0 ? `nothing of theirs touches our files or names #${String(target.issue_no)}` : hits.join('; ') }
  }
}

export function work(read: Read, root: string, plan: number, target: Target, paths: Paths = diffed): Hit[] {
  const files = paths(root, plan)
  let mine: Map<string, Set<string>> | undefined
  const same: Same = (shared, of) => shared.some((path) => {
    mine ??= mineOf(root, plan)
    const held = mine.get(path)
    return held !== undefined && [...contexts(of(path))].some((c) => held.has(c))
  })
  return [...prs(read, target, files, same), ...siblings(read, target), ...branches(srcDir(root, plan), target, files, same)]
}

export function picked(read: Read = gh): Check {
  return theirs(read, named)
}

function diffed(root: string, plan: number): string[] {
  return parse(diffOf(root, plan)).map((f) => f.path)
}

/** The ask's tokens that are files in the checkout; before a build that tree is upstream main. */
export function named(root: string, plan: number): string[] {
  const dir = srcDir(root, plan)
  const tokens = unhoused(maybe(root, plan, 'ask.md') ?? '').match(/[\w./-]+/g) ?? []
  return [...new Set(tokens.map((t) => t.replace(/\.+$/, '')))]
    .filter((t) => !t.includes('..') && statSync(join(dir, t), { throwIfNoEntry: false })?.isFile() === true)
}

function prs(read: Read, target: Target, paths: string[], same: Same): Hit[] {
  const owner = ownerOf(target.repo)
  return Prs.parse(read(['pr', 'list', '--repo', target.repo, '--state', 'open', '--limit', String(WINDOW),
    '--json', 'number,url,title,body,isDraft,author,headRepositoryOwner,files']))
    .filter((p) => !ours(p.headRepositoryOwner?.login))
    .filter((p) => p.headRepositoryOwner?.login === owner || p.author?.login === target.named_merger)
    .flatMap((p) => {
      const found = hit(paths, p.files.map((f) => f.path), mentions(`${p.title}\n${p.body}`, target.issue_no), target.issue_no)
      if (found === null) return []
      const patches = found.files.length === 0 ? new Map<string, string>() : patchesOf(read, target.repo, p.number)
      return [made(p.isDraft ? 'draft' : 'pr', p.url, found, same(found.files, (f) => patches.get(f) ?? ''))]
    })
}

function patchesOf(read: Read, repo: string, no: number): Map<string, string> {
  return new Map(Patches.parse(read(['api', `repos/${repo}/pulls/${String(no)}/files?per_page=100`]))
    .map((f) => [f.filename, f.patch ?? '']))
}

function siblings(read: Read, target: Target): Hit[] {
  const no = String(target.issue_no)
  return Siblings.parse(read(['search', 'prs', `${target.repo}#${no}`, '--owner', ownerOf(target.repo),
    '--state', 'open', '--json', 'url,repository']))
    .filter((p) => p.repository.nameWithOwner !== target.repo)
    .map((p) => made('pr', p.url, { says: `names #${no}`, files: [] }, false))
}

function branches(dir: string, target: Target, paths: string[], same: Same): Hit[] {
  git(dir, ['fetch', '--no-tags', 'upstream'])
  const since = Date.now() - RECENT * 86_400_000
  return git(dir, ['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/upstream']).split('\n').flatMap((name) => {
    if (name === '' || name === 'main') return []
    const ref = `refs/remotes/upstream/${name}`
    if (Date.parse(git(dir, ['log', '-1', '--format=%cI', ref]).trim()) < since) return []
    const base = baseOf(dir, ref)
    if (base === null) return []
    const changed = git(dir, ['diff', '--name-only', base, ref]).split('\n')
    const said = git(dir, ['log', '-z', '--format=%B', `${base}..${ref}`])
    const found = hit(paths, changed, mentions(said, target.issue_no), target.issue_no)
    if (found === null) return []
    const url = `https://github.com/${target.repo}/tree/${name}`
    return [made('branch', url, found, same(found.files, (f) => git(dir, ['diff', base, ref, '--', f])))]
  })
}

/** An orphan branch shares no history with main, so it holds no work on ours; `merge-base` throws on one. */
function baseOf(dir: string, ref: string): string | null {
  try {
    return git(dir, ['merge-base', MAIN, ref]).trim()
  } catch {
    return null
  }
}

function hit(paths: string[], touched: string[], named: boolean, no: number): Found | null {
  const files = paths.filter((p) => touched.includes(p))
  if (files.length > 0) return { says: `touches ${files.join(', ')}`, files }
  return named ? { says: `names #${String(no)}`, files } : null
}

function made(kind: string, url: string, found: Found, same: boolean): Hit {
  return { url, says: `${kind} ${url} ${found.says}`, files: found.files, same, code: kind === 'branch' && found.files.some(coded) }
}

function mineOf(root: string, plan: number): Map<string, Set<string>> {
  return new Map(diffOf(root, plan).split(/^(?=diff --git )/m).flatMap((part) => {
    const path = parse(part)[0]?.path
    return path === undefined ? [] : [[path, contexts(part)] as const]
  }))
}

/** The trimmed text after a hunk line's second `@@`, which git fills with the function line above the hunk. */
function contexts(hunks: string): Set<string> {
  return new Set([...hunks.matchAll(/^@@ [^@]*@@(.*)$/gm)].map((m) => (m[1] ?? '').trim()).filter((c) => c !== ''))
}

function ownerOf(repo: string): string {
  return repo.slice(0, repo.indexOf('/'))
}
