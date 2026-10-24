import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { conformance, exported } from '../cli/export.ts'
import { record, ticketOf } from '../cli/inbox.ts'
import { aged, aired, awaiting, paste, pending, placed, type Post, published } from '../store/desk.ts'
import { lastSince, logged, pointers } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { get, hhmm, zone } from '../store/lanes.ts'
import type { PlanRow } from '../store/plans.ts'
import { titled } from '../templates/comms.ts'
import type { Step } from '../templates/pr-path.ts'
import type { Outcome } from './kind.ts'
import { firstLine } from './unpolled.ts'
import { shift } from './weekly.ts'
import { abortMerge, git, unmerged } from './workspace.ts'

const TEMPLATE = '05_jito-tippayment-and-ai-invariant-suggester-live.html'

const REDESIGN = 'redesign-2026-10'

const escaped = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

export function render(siteDir: string, post: { title: string; dek: string; body: string; work_date: string; written_date: string; kind?: string }): string {
  const blog = join(siteDir, 'blog')
  const page = readFileSync(join(blog, TEMPLATE), 'utf8')
  const index = readFileSync(join(blog, 'index.html'), 'utf8')
  const end = ['</article>', '</main>', '</body>'].map((tag) => page.indexOf(tag)).find((at) => at !== -1)
  if (end === undefined) throw new Error(`${TEMPLATE} has no </article>, </main> or </body>`)
  if (!index.includes('<article class="cf-blog-card"')) throw new Error('blog/index.html has no cf-blog-card')
  const title = escaped(post.title)
  const dek = escaped(post.dek)
  const n = Math.max(0, ...readdirSync(blog).flatMap((f) => /^(\d{2})_/.exec(f)?.[1] ?? []).map(Number)) + 1
  const name = `${String(n).padStart(2, '0')}_${post.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
  const arced = post.kind === 'weekly' ? arc(siteDir, index, post, name, title, dek) : index
  const at = arced.indexOf('<article class="cf-blog-card"')
  const body = post.body.split(/\n\s*\n/).map((block) => block.trim()).filter((block) => block !== '')
    .map((block) => (block.startsWith('## ') ? `<h2>${escaped(block.slice(3))}</h2>` : `<p>${escaped(block)}</p>`))
  writeFileSync(join(blog, `${name}.html`), [page.slice(0, page.indexOf('<h1')).replace(/<title>[\s\S]*?<\/title>/, () => `<title>${title}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${dek}">`)
    .replace(/<link[^>]*href="\/caliper\.css"[^>]*>/, (link) => (page.includes('href="/site.css"') ? link : `${link}\n<link rel="stylesheet" href="/site.css">`)),
    `<h1>${title}</h1>`, `<p class="dateline">Work completed ${post.work_date} · written up ${post.written_date}.</p>`, ...body, page.slice(end)].join('\n'))
  const day = new Date(`${post.work_date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  const card = `<article class="cf-blog-card">\n<p class="dateline">${day}</p>\n<h2><a href="${name}.html">${title}</a></h2>\n<p class="summary">${dek}</p>\n</article>\n`
  writeFileSync(join(blog, 'index.html'), arced.slice(0, at) + card + arced.slice(at))
  return name
}

function arc(siteDir: string, index: string, post: { dek: string; work_date: string }, name: string, title: string, dek: string): string {
  const s = index.indexOf('<section class="log-arcs"')
  if (s === -1) throw new Error('blog/index.html has no section.log-arcs')
  const open = index.indexOf('>', s) + 1
  const close = index.indexOf('</section>', open)
  const first = index.indexOf('<article class="cf-arc-card"', open)
  const at = first !== -1 && first < close ? first : close
  const data = join(siteDir, 'data')
  const known = new Set(readdirSync(data).filter((f) => f.endsWith('.json')).flatMap((f) => readFileSync(join(data, f), 'utf8').match(/\d+/g) ?? []))
  const stray = post.dek.match(/\d+/g)?.find((d) => !known.has(d))
  if (stray !== undefined) throw new Error(`weekly summary holds ${stray}, not in data/*.json`)
  const date = (day: string, parts: Intl.DateTimeFormatOptions): string =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { ...parts, timeZone: 'UTC' })
  const sunday = shift(post.work_date, 6)
  const monday = date(post.work_date, sunday.startsWith(post.work_date.slice(0, 7)) ? { day: 'numeric' } : { day: 'numeric', month: 'long' })
  const dateline = `Weekly arc · ${monday} to ${date(sunday, { day: 'numeric', month: 'long', year: 'numeric' })}`
  const card = `<article class="cf-arc-card">\n<p class="dateline">${dateline}</p>\n<h2><a href="${name}.html">${title}</a></h2>\n<p class="summary">${dek}</p>\n</article>\n`
  return index.slice(0, at) + card + index.slice(at)
}

export function commit(siteDir: string, name: string): void {
  git(siteDir, ['add', `blog/${name}.html`, 'blog/index.html'])
  git(siteDir, ['commit', '-m', `post: ${name}`])
}

export function push(db: Db, now: Date): number {
  const dir = siteDir(db)
  if (dir === null) throw new Error('comms.site_dir is unset')
  served(dir)
  send(dir)
  const count = published(db, now.toISOString())
  logged(db, { plan: null, kind: 'site_push', actor: 'ceo', outcome: 'pass', message: `${String(count)} post(s)`, pointer: null, run: null }, now.toISOString())
  return count
}

export function ripe(db: Db, now: Date): void {
  const dir = siteDir(db)
  const stamp = (at: Date): string => at.toISOString().replace('T', ' ').slice(0, 19)
  const rows = aged(db, stamp(new Date(now.getTime() - 86_400_000)), stamp(now))
  if (dir === null || rows.length === 0 || awaiting(db)) return
  try {
    served(dir)
    for (const row of rows.filter((r) => r.url === null)) place(db, dir, row)
    send(dir)
    aired(db, rows.map((r) => r.id), now.toISOString())
    logged(db, { plan: null, kind: 'site_push', actor: 'tick', outcome: 'pass', message: `${String(rows.length)} post(s)`, pointer: null, run: null },
      now.toISOString())
  } catch (error) {
    const [outcome, message] = [error instanceof Conflict ? 'needs_coo' as const : 'refuse' as const, said(error)]
    const last = lastSince(db, 'site_push', new Date(now.getTime() - 86_400_000).toISOString())
    if (last?.outcome !== outcome || last.message !== message) {
      logged(db, { plan: null, kind: 'site_push', actor: 'tick', outcome, message, pointer: null, run: null }, now.toISOString())
    }
  }
}

class Conflict extends Error {}

function served(dir: string): void {
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  if (branch !== 'main') throw new Conflict(`site checkout is on ${branch}, not main`)
}

function said(error: unknown): string {
  const stderr = error instanceof Error && 'stderr' in error ? error.stderr : undefined
  const lines = typeof stderr === 'string' ? stderr.split('\n').map((l) => l.trim()) : []
  return lines.find((l) => l !== '' && !l.startsWith('To ')) ?? firstLine(error)
}

function send(dir: string): void {
  git(dir, ['fetch'])
  const upstream = git(dir, ['rev-parse', '--abbrev-ref', '@{upstream}']).trim()
  try {
    git(dir, ['merge', '--no-edit', upstream])
  } catch (error) {
    const files = unmerged(dir)
    abortMerge(dir)
    if (files.length > 0) throw new Conflict(`${upstream} conflicts on ${files.join(', ')}`)
    throw error
  }
  git(dir, ['push'])
}

function place(db: Db, dir: string, row: Post): void {
  const name = render(dir, { ...row, title: row.edited_title ?? row.title, dek: row.edited_dek ?? row.dek, body: row.edited_body ?? row.body })
  commit(dir, name)
  placed(db, row.id, `https://caliperforge.com/blog/${name}.html`)
}

function siteDir(db: Db): string | null {
  const value = get(db, 'comms.site_dir')
  return value === '' ? null : value.replace(/^~(?=\/|$)/, homedir())
}

/** The site's `data/*.json`, exported, committed and pushed once per local date from 05:15; a refusal is logged and not retried that date. */
export function sitedata(db: Db, root: string, now: Date): void {
  const day = new Date(now.getTime() + zone(db) * 60000).toISOString().slice(0, 10)
  if (hhmm(db, now) < '05:15' || pointers(db, 'site_data').includes(day)) return
  const event = { plan: null, kind: 'site_data', actor: 'tick', pointer: day, run: null }
  const dir = siteDir(db)
  if (dir === null) {
    logged(db, { ...event, outcome: 'refuse', message: 'comms.site_dir is unset' })
    return
  }
  try {
    served(dir)
    const files = exported(join(root, 'cf.db'), dir, now).map((p) => relative(dir, p))
    git(dir, ['add', '--', ...files])
    const changed = git(dir, ['diff', '--cached', '--name-only', '--', ...files]).split('\n').filter((l) => l !== '')
    if (changed.length > 0) {
      git(dir, ['commit', '-m', `data: ${day}`, '--', ...changed])
      send(dir)
    }
    logged(db, { ...event, outcome: 'pass', message: `${String(changed.length + redesign(dir, day, now))} files` })
  } catch (error) {
    logged(db, { ...event, outcome: error instanceof Conflict ? 'needs_coo' : 'refuse', message: said(error) })
  }
}

function redesign(dir: string, day: string, now: Date): number {
  git(dir, ['fetch', 'origin', REDESIGN])
  const tmp = mkdtempSync(join(tmpdir(), 'cf-sitedata-'))
  const tree = join(tmp, 'tree')
  try {
    git(dir, ['worktree', 'add', '--detach', tree, `origin/${REDESIGN}`])
    const path = relative(tree, conformance(tree, now))
    git(tree, ['add', '--', path])
    if (git(tree, ['diff', '--cached', '--name-only', '--', path]).trim() === '') return 0
    git(tree, ['commit', '-m', `data: ${day}`, '--', path])
    git(tree, ['push', 'origin', `HEAD:${REDESIGN}`])
    return 1
  } finally {
    if (existsSync(tree)) git(dir, ['worktree', 'remove', '--force', tree])
    rmSync(tmp, { recursive: true, force: true })
  }
}

export function publish(db: Db, root: string, plan: PlanRow, step: Step): Outcome {
  if (titled(db, plan, 'daily') !== null) return { outcome: 'pass', spans: [], note: 'daily plan; nothing to publish' }
  const rows = pending(db)
  if (rows.length === 0) return { outcome: 'pass', spans: [], note: 'nothing to publish' }
  const dir = siteDir(db)
  if (dir === null) return { outcome: 'refuse', spans: ['comms.site_dir'], note: 'comms.site_dir is unset' }
  for (const row of rows) place(db, dir, row)
  paste(db)
  record(root, [{ at: new Date().toISOString(), plan: plan.id, ticket: ticketOf(db, plan.id), kind: 'signoff', step: step.step, name: step.name,
    note: 'site post ready: run `cf site push`' }])
  return { outcome: 'pass', spans: [], note: `${String(rows.length)} post(s) written to ${dir}` }
}
