import { inline, said, type Read } from '../cli/gh.ts'
import type { Db } from '../store/index.ts'
import { graded, type Signal } from '../store/signals.ts'
import { carried } from './push.ts'
import { cloned, drop, headSha, maybe, put } from './workspace.ts'

export interface Rehearsal { root: string; list: Read }

/** Each bot review at the plan head its tip carries, with the reviewer's inline comments at its commit kept there under `G<comment id>`, an id that holds across rounds. */
export function rehearsed({ root, list }: Rehearsal, plan: number, fork: string, pr: number, all: Signal[]): Signal[] {
  const bots = all.filter((s) => s.kind === 'bot_review')
  const comments = bots.length === 0 ? [] : inline(fork, pr, list)
  return bots.map((s) => {
    const head = typeof s.head === 'string' ? carried(root, plan, s.head) : null
    const found = comments.filter((c) => c.user.login === s.author && c.commit_id === s.head)
    if (head !== null && found.length > 0) put(root, plan, `findings-${head}.md`, found.map((c) => `- G${String(c.id)} ${said(c)}\n`).join(''))
    return { ...s, head }
  })
}

/** `findings.md` is what the completion audit reads, so a head Greptile passed leaves none behind. */
export function findings(db: Db, root: string, plan: number, src: string): string {
  const head = cloned(src) ? headSha(src) : null
  const score = head === null ? null : graded(db, plan, head)?.score ?? null
  const lines = head !== null && score !== null && score < 5 ? maybe(root, plan, `findings-${head}.md`) ?? '' : ''
  if (lines.trim() === '') {
    drop(root, plan, 'findings.md')
    return ''
  }
  put(root, plan, 'findings.md', lines)
  return `\n\n# Bot review findings\n\nGreptile scored this head ${String(score)}/5. Answer each finding under its id in your hand-back's done rows, with a pointer.\n\n${lines}`
}
