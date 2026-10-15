import { BOT } from '../sequencer/capture.ts'
import type { Db } from '../store/index.ts'
import { prsOf, putRecord, recordsOf, type Row } from '../store/record.ts'
import { pr as readPr, prNumber, type Pr } from './gh.ts'

export { still, type Row } from '../store/record.ts'

interface Word { by: string; at: string; text: string }

export function fill(db: Db, repo: string, read: (repo: string, no: number) => Pr = readPr): Row[] {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error(`"${repo}" is not owner/repo`)
  for (const o of prsOf(db, repo)) {
    const view = read(repo, prNumber(o.evidence))
    const last = word(view)
    putRecord(db, { repo, pr: view.number, plan: o.plan, url: view.url, state: view.state, merged_at: view.mergedAt,
      word_by: last?.by ?? null, word_at: last?.at ?? null, word: last?.text ?? null, read_at: new Date().toISOString() })
  }
  return recordsOf(db, repo)
}

function word(view: Pr): Word | null {
  const theirs = (w: Word): boolean => w.by !== view.author?.login && !BOT.test(w.by)
  return [
    ...view.comments.map((c) => ({ by: c.author.login, at: c.createdAt, text: c.body.trim() })),
    ...view.reviews.map((r) => ({ by: r.author.login, at: r.submittedAt, text: r.body.trim() === '' ? r.state ?? '' : r.body.trim() })),
  ].filter(theirs).sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null
}

export function render(repo: string, rows: Row[], open: number): string {
  return `${repo}\topen ${String(open)}\n` + rows.map((r) => {
    const said = r.word_by === null || r.word === null ? '-' : `${r.word_by}: ${r.word.replace(/\n[\s\S]*/, '').slice(0, 100)}`
    return `#${String(r.pr)}\t${r.state}\tplan ${String(r.plan)}\t${said}\t${r.url}\n`
  }).join('')
}
