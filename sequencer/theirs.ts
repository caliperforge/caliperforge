import { statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { gh, mentions, ours, WINDOW, type Read } from '../cli/gh.ts'
import { parse } from '../rails/diff.ts'
import type { Check, Target } from './card.ts'
import { diffOf, git, MAIN, maybe, srcDir } from './workspace.ts'

const Login = z.object({ login: z.string() })

const Prs = z.array(z.object({
  url: z.string(),
  title: z.string(),
  body: z.string(),
  isDraft: z.boolean(),
  author: Login.nullable(),
  headRepositoryOwner: Login.nullable(),
  files: z.array(z.object({ path: z.string() })),
}))

const Siblings = z.array(z.object({ url: z.string(), repository: z.object({ nameWithOwner: z.string() }) }))

const RECENT = 30

type Paths = (root: string, plan: number) => string[]

export function theirs(read: Read = gh, paths: Paths = diffed): Check {
  return (...[, root, plan, target]) => {
    const files = paths(root, plan)
    const hits = [...prs(read, target, files), ...siblings(read, target), ...branches(srcDir(root, plan), target, files)].sort()
    return { check: 'their work', ok: hits.length === 0,
      says: hits.length === 0 ? `nothing of theirs touches our files or names #${String(target.issue_no)}` : hits.join('; ') }
  }
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
  const tokens = (maybe(root, plan, 'ask.md') ?? '').match(/[\w./-]+/g) ?? []
  return [...new Set(tokens.map((t) => t.replace(/\.+$/, '')))]
    .filter((t) => !t.includes('..') && statSync(join(dir, t), { throwIfNoEntry: false })?.isFile() === true)
}

function prs(read: Read, target: Target, paths: string[]): string[] {
  const owner = ownerOf(target.repo)
  return Prs.parse(read(['pr', 'list', '--repo', target.repo, '--state', 'open', '--limit', String(WINDOW),
    '--json', 'number,url,title,body,isDraft,author,headRepositoryOwner,files']))
    .filter((p) => !ours(p.headRepositoryOwner?.login))
    .filter((p) => p.headRepositoryOwner?.login === owner || p.author?.login === target.named_merger)
    .flatMap((p) => {
      const found = hit(paths, p.files.map((f) => f.path), mentions(`${p.title}\n${p.body}`, target.issue_no), target.issue_no)
      return found === null ? [] : [`${p.isDraft ? 'draft' : 'pr'} ${p.url} ${found}`]
    })
}

function siblings(read: Read, target: Target): string[] {
  const no = String(target.issue_no)
  return Siblings.parse(read(['search', 'prs', `${target.repo}#${no}`, '--owner', ownerOf(target.repo),
    '--state', 'open', '--json', 'url,repository']))
    .filter((p) => p.repository.nameWithOwner !== target.repo)
    .map((p) => `pr ${p.url} names #${no}`)
}

function branches(dir: string, target: Target, paths: string[]): string[] {
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
    return found === null ? [] : [`branch https://github.com/${target.repo}/tree/${name} ${found}`]
  })
}

/** An orphan branch shares no history with main, so it holds no work on ours: php-sdk's `badges` threw at push (09-28). */
function baseOf(dir: string, ref: string): string | null {
  try {
    return git(dir, ['merge-base', MAIN, ref]).trim()
  } catch {
    return null
  }
}

function hit(paths: string[], touched: string[], named: boolean, no: number): string | null {
  const shared = paths.filter((p) => touched.includes(p))
  if (shared.length > 0) return `touches ${shared.join(', ')}`
  return named ? `names #${String(no)}` : null
}

function ownerOf(repo: string): string {
  return repo.slice(0, repo.indexOf('/'))
}
