import { BOT } from '../sequencer/capture.ts'
import type { Db } from '../store/index.ts'
import { openRecords, prsOf, putRecord, recordsOf, type Row } from '../store/record.ts'
import { pr as readPr, prNumber, standing, type Outside, type Pr, type Standing } from './gh.ts'

export { still, type Row } from '../store/record.ts'

interface Word { by: string; at: string; text: string }

interface Asked { repo: string; pr: number }

export function fill(db: Db, repo: string | null, read: (repo: string, no: number) => Pr = readPr, found: Outside[] = [],
  look: (repo: string, no: number) => Standing = standing): Row[] {
  if (repo !== null && !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error(`"${repo}" is not owner/repo`)
  const hits = found.filter((f) => repo === null || f.repository.nameWithOwner === repo)
  for (const at of asked(db, repo, hits)) {
    const view = read(at.repo, at.pr)
    const all = words(view)
    const last = word(view, all)
    const bot = all.filter((w) => BOT.test(w.by)).at(-1)
    const hit = hits.find((f) => f.repository.nameWithOwner === at.repo && f.number === at.pr)
    const seen = hit === undefined ? null : look(at.repo, at.pr)
    putRecord(db, { repo: at.repo, pr: view.number, plan: planOf(db, at), url: view.url, state: view.state, merged_at: view.mergedAt,
      word_by: last?.by ?? null, word_at: last?.at ?? null, word: last?.text ?? null, read_at: new Date().toISOString(),
      title: hit?.title ?? null, opened_at: hit?.createdAt ?? null, bot_by: bot?.by ?? null, bot_at: bot?.at ?? null,
      findings: seen?.unresolved ?? null, mergeable: seen?.mergeable ?? null, ball: seen === null ? null : ball(view, all, seen.committed) })
  }
  return repo === null ? openRecords(db, null) : recordsOf(db, repo)
}

function asked(db: Db, repo: string | null, hits: Outside[]): Asked[] {
  const all: Asked[] = [
    ...hits.map((f) => ({ repo: f.repository.nameWithOwner, pr: f.number })),
    ...(repo === null ? [] : prsOf(db, repo).map((o) => ({ repo, pr: prNumber(o.evidence) }))),
    ...openRecords(db, repo),
  ]
  return [...new Map(all.map((a) => [`${a.repo}#${String(a.pr)}`, { repo: a.repo, pr: a.pr }])).values()]
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.pr - b.pr)
}

function planOf(db: Db, at: Asked): number | null {
  return new Map(prsOf(db, at.repo).map((o) => [prNumber(o.evidence), o.plan])).get(at.pr) ?? null
}

function words(view: Pr): Word[] {
  return [
    ...view.comments.map((c) => ({ by: c.author.login, at: c.createdAt, text: c.body.trim() })),
    ...view.reviews.map((r) => ({ by: r.author.login, at: r.submittedAt, text: r.body.trim() === '' ? r.state ?? '' : r.body.trim() })),
  ].sort((a, b) => a.at.localeCompare(b.at))
}

function word(view: Pr, all: Word[]): Word | null {
  return all.filter((w) => w.by !== view.author?.login && !BOT.test(w.by)).at(-1) ?? null
}

function ball(view: Pr, all: Word[], committed: string | null): 'us' | 'them' {
  const mine = all.filter((w) => w.by === view.author?.login).at(-1)?.at ?? null
  const theirs = all.filter((w) => w.by !== view.author?.login).at(-1)?.at
  return theirs !== undefined && [committed, mine].every((t) => t === null || theirs > t) ? 'us' : 'them'
}

function said(r: Row): string {
  return r.word_by === null || r.word === null ? '-' : `${r.word_by}: ${r.word.replace(/\n[\s\S]*/, '').slice(0, 100)}`
}

export function render(repo: string, rows: Row[], open: number): string {
  return `${repo}\topen ${String(open)}\n` + rows.map((r) =>
    `#${String(r.pr)}\t${r.state}\tplan ${r.plan === null ? '-' : String(r.plan)}\t${said(r)}\t${r.url}\n`).join('')
}

export function renderOpen(rows: Row[], now: Date): string {
  return rows.map((r) => {
    const days = r.opened_at === null ? '-' : `${String(Math.floor((now.getTime() - Date.parse(r.opened_at)) / 86400000))}d`
    const bot = r.bot_by === null || r.bot_at === null ? '-' : `${r.bot_by} ${r.bot_at.slice(0, 10)}`
    return `${r.repo}\t#${String(r.pr)}\t${r.title ?? '-'}\t${days}\tball ${r.ball ?? '-'}\t${r.mergeable ?? '-'}\t${bot}\t`
      + `${r.findings === null ? '-' : String(r.findings)} unresolved\t${said(r)}\n`
  }).join('')
}
