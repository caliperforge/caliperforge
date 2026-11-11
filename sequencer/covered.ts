import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { WINDOW, type Read } from '../cli/gh.ts'
import { registered } from '../runner/rules.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { newestOfOrigin, type PlanRow } from '../store/plans.ts'
import { refusalRows } from '../store/refusals.ts'
import { waitable } from '../store/stops.ts'

const Issues = z.array(z.object({ number: z.int(), title: z.string(), body: z.string(), url: z.string(),
  comments: z.array(z.object({ body: z.string() })).optional() }))

type Issue = z.infer<typeof Issues>[number]

/** The comment `land()` in sequencer/push.ts closes a landed ticket with. */
const LANDED = /landed on \S+ as ([0-9a-f]{7,40})/

const CODE = /`([^`]+)`|(\w+\(\))|\b(\w*(?:_|[a-z][A-Z])\w*)/g

const CITED = /([\w./-]+\.\w+):(\d+)(?:-(\d+))?/g

const PATH = /(?<![\w./:-])(?:[\w-]+\/)+[\w.-]+\.[a-z]{1,5}\b/g

const DAYS = 14

export type Cover = ({ verdict: 'landed'; no: number; url: string; sha: string } | { verdict: 'open'; no: number; url: string; plan: number | null }
  | { verdict: 'unreplaced'; name: string } | { verdict: 'filed' }) & { open: number; landed: number; names: number }

interface Draft { title: string; text: string; spans: Cited[]; names: string[] }

interface Cited { path: string; from: number; to: number }

export function covered(db: Db, root: string, plan: PlanRow | null, repo: string, title: string, body: string, now: Date, read: Read): Cover {
  const since = new Date(now.getTime() - DAYS * 86_400_000).toISOString().slice(0, 10)
  const open = listed(read, repo, ['--state', 'open'], 'number,title,body,url')
  const landed = listed(read, repo, ['--state', 'closed', '--search', `closed:>=${since}`], 'number,title,body,url,comments')
    .flatMap((i) => {
      const sha = i.comments?.map((c) => LANDED.exec(c.body)?.[1]).find((s) => s !== undefined)
      return sha === undefined ? [] : [{ ...i, sha }]
    })
  const names = registry(root)
  const counts = { open: open.length, landed: landed.length, names: names.length }
  const draft = { title, text: `${title}\n${body}`,
    spans: plan === null ? [] : cites(refusalRows(db, plan.id).map((r) => r.span ?? '').join('\n')), names: named(`${title}\n${body}`, names) }
  const hit = landed.find((i) => covers(draft, i, names))
  if (hit !== undefined) return { verdict: 'landed', no: hit.number, url: hit.url, sha: hit.sha, ...counts }
  for (const i of open.filter((o) => covers(draft, o, names))) {
    const on = newestOfOrigin(db, i.url)
    if (plan === null || (on !== undefined && waitable(db, on.id, plan.id))) {
      return { verdict: 'open', no: i.number, url: i.url, plan: on?.id ?? null, ...counts }
    }
  }
  const name = draft.names[0]
  if (name !== undefined && !/^Replaces: \S/m.test(body)) return { verdict: 'unreplaced', name, ...counts }
  return { verdict: 'filed', ...counts }
}

export function compared(db: Db, plan: number | null, actor: string, title: string, cover: Cover, pointer: string | null): void {
  logged(db, { plan, kind: 'covered', actor, outcome: cover.verdict === 'unreplaced' ? 'refuse' : 'pass',
    message: `compared "${title}" with ${String(cover.open)} open, ${String(cover.landed)} landed, ${String(cover.names)} registry lines: ${said(cover)}`,
    pointer, run: null })
}

export function said(cover: Cover): string {
  switch (cover.verdict) {
    case 'landed': return `landed as ${cover.sha}`
    case 'open': return `covered by #${String(cover.no)}`
    case 'unreplaced': return `not filed: names registry line ${cover.name} with no Replaces: line`
    case 'filed': return 'filed'
  }
}

function listed(read: Read, repo: string, state: string[], fields: string): Issue[] {
  const found = Issues.parse(read(['issue', 'list', '--repo', repo, ...state, '--limit', String(WINDOW), '--json', fields]))
  if (found.length >= WINDOW) throw new Error(`gh issue list on ${repo} hit its cap of ${String(WINDOW)}; issues past it are unread`)
  return found
}

function registry(root: string): string[] {
  return registered(root).flatMap((path) => [...readFileSync(join(root, path), 'utf8').matchAll(/^- name: (\S+)$/gm)].map((m) => m[1] ?? ''))
}

function covers(draft: Draft, issue: Issue, names: string[]): boolean {
  const text = `${issue.title}\n${issue.body}`
  const token = tokens(draft.title)[0]
  const paths = draft.text.match(PATH) ?? []
  return (token === undefined ? issue.title === draft.title : issue.title.includes(token))
    || cites(issue.body).some((c) => draft.spans.some((s) => s.path === c.path && c.from <= s.from && s.to <= c.to))
    || named(text, names).some((n) => draft.names.includes(n))
    || (paths.length > 0 && paths.every((p) => text.match(PATH)?.includes(p) === true))
}

/** Backticked words, `name()` calls and identifiers with `_` or an inner capital, so prose that says "director" names no registry line. */
function tokens(text: string): string[] {
  return [...text.matchAll(CODE)].map((m) => m[1] ?? m[2] ?? m[3] ?? '')
}

function named(text: string, names: string[]): string[] {
  const said = new Set(tokens(text))
  return names.filter((n) => said.has(n))
}

function cites(text: string): Cited[] {
  return [...text.matchAll(CITED)].map((m) => ({ path: m[1] ?? '', from: Number(m[2]), to: Number(m[3] ?? m[2]) }))
}
