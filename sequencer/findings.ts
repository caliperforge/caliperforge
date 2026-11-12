import { readdirSync } from 'node:fs'
import { inline, said, type Read } from '../cli/gh.ts'
import type { Judged } from '../reviews/verdict.ts'
import type { Db } from '../store/index.ts'
import { asks, graded, type Signal } from '../store/signals.ts'
import { verdictRows } from '../store/verdict.ts'
import { BOT } from './capture.ts'
import { carried } from './push.ts'
import { rows } from './listed.ts'
import { listed, unruled } from './unruled.ts'
import { cloned, drop, headSha, maybe, planDir, put, srcDir } from './workspace.ts'

export interface Rehearsal { root: string; list: Read }

/** A finding is named by GitHub's comment id: a row the audit carries from an earlier hand-back then answers the same finding, never a renumbered one. */
export function rehearsed({ root, list }: Rehearsal, plan: number, fork: string, pr: number, all: Signal[]): Signal[] {
  const bots = all.filter((s) => s.kind === 'bot_review')
  const comments = bots.length === 0 ? [] : kept(root, plan, fork, pr, bots, list)
  const paths = comments.filter((c) => BOT.test(c.user.login)).map((c) => `G${String(c.id)} ${c.path}\n`).join('')
  if (paths !== '') put(root, plan, 'findings.paths', paths)
  return bots.map((s) => ({ ...s, head: typeof s.head === 'string' ? carried(root, plan, s.head) : null }))
}

export function kept(root: string, plan: number, repo: string, pr: number, bots: Pick<Signal, 'head'>[], list: Read): ReturnType<typeof inline> {
  const comments = inline(repo, pr, list)
  for (const { head } of bots) {
    const found = comments.filter((c) => BOT.test(c.user.login) && c.original_commit_id === head)
    if (typeof head === 'string' && found.length > 0) put(root, plan, `findings-${carried(root, plan, head)}.md`, found.map((c) => `- G${String(c.id)} ${said(c)}\n`).join(''))
  }
  return comments
}

export function rowsAt(root: string, plan: number, head: string | null): string[] {
  return head === null ? [] : rows(maybe(root, plan, `findings-${head}.md`) ?? '').map((r) => r.text.trimEnd())
}

/** `findings.md` is what the completion audit reads, so a head Greptile passed leaves none behind. */
export function findings(db: Db, root: string, plan: number, src: string): string {
  const head = cloned(src) ? headSha(src) : null
  const score = head === null ? null : graded(db, plan, head)?.score ?? null
  const lines = head !== null && score !== null && score < 5 ? maybe(root, plan, `findings-${head}.md`) ?? '' : ''
  const ruled = head === null ? [] : unruled(root, plan, head).ruled
  const blind = head === null ? '' : listed(root, plan, head).filter((f) => f.id.startsWith('B') && !ruled.includes(f.id)).map((f) => f.text).join('')
  const told = blind === '' ? '' : `\n\n# Blind review findings\n\nUnder \`## Findings answered\` in your hand-back, above the fence, write one row per id: \`- B1 fixed: <how>\` or \`- B1 disputed: <why>\`.\n\n${blind}`
  if (lines.trim() === '') {
    drop(root, plan, 'findings.md')
    return told
  }
  put(root, plan, 'findings.md', lines)
  return `\n\n# Bot review findings\n\nGreptile scored this head ${String(score)}/5. Answer each finding under its id in your hand-back's done rows, with a pointer.\n\n${lines}${told}`
}

/** `findings.open.md` is what step 3 reads: a row whose span `narrowed()` dropped is not open. */
export function left(root: string, plan: number, outcome: Judged): void {
  if (outcome.outcome === 'needs_ceo') return
  const rows = outcome.message.split('\n').filter((l) => /^- F\d+ /.test(l) && outcome.spans.includes(l.split(' ')[2] ?? '')).map((l) => `${l}\n`).join('')
  if (rows === '') drop(root, plan, 'findings.open.md')
  else put(root, plan, 'findings.open.md', rows)
}

export function owed(root: string, plan: number): string {
  const rows = maybe(root, plan, 'findings.open.md')
  return rows === null ? '' : `\n\n# Review findings\n\nUnder \`## Findings answered\` in your hand-back, above the fence, write one row per id: \`- F1 fixed: <how>\` or \`- F1 disputed: <why>\`.\n\n${rows}`
}

/** Step 5 has no commit yet, so the blind pass files its rows under the tree it judged. */
export function blinded(db: Db, root: string, plan: number, { verdict, outcome }: { verdict: number; outcome: { message: string } }): void {
  const tree = verdictRows(db, plan).find((v) => v.id === verdict)?.tree ?? null
  if (tree === null) return
  const top = Math.max(0, ...readdirSync(planDir(root, plan)).filter((name) => /^findings-[0-9a-f]{40}\.md$/.test(name))
    .flatMap((name) => rows(maybe(root, plan, name) ?? '')).filter((f) => f.id.startsWith('B')).map((f) => Number(f.id.slice(1))))
  const lines = outcome.message.split('\n').filter((l) => /^- B\d+ P[1-3] /.test(l))
    .map((l, i) => `${l.replace(/^- B\d+/, `- B${String(top + i + 1)}`)}\n`).join('')
  if (lines === '') drop(root, plan, `findings-${tree}.md`)
  else put(root, plan, `findings-${tree}.md`, lines)
}

export function found(db: Db, root: string, plan: number): string {
  const src = srcDir(root, plan)
  const greptile = cloned(src) ? maybe(root, plan, `findings-${headSha(src)}.md`) ?? '' : ''
  const tree = verdictRows(db, plan).findLast((v) => v.gate === 'blind_review' && v.tree !== null)?.tree ?? null
  const rows = greptile + (tree === null ? '' : maybe(root, plan, `findings-${tree}.md`) ?? '')
  return rows === '' ? 'none' : `Answer a finding you judge wrong with \`rule\`, \`answer: <id> overruled: <evidence>\`.\n\n${rows}`
}

/** An ask is named by its `signals` id, as a finding is by its comment id: the sign-off card reads its `R` row back. */
export function asked(db: Db, plan: number): string {
  const lines = asks(db, plan).map((s) =>
    `- R${String(s.id)} ${s.author} (${s.kind}${s.state === null ? '' : `, ${s.state}`}): ${(s.body ?? '').replace(/\s+/g, ' ').trim()}\n`).join('')
  return lines === '' ? '' : `\n\n# Reviewer asks\n\nAnswer each ask under its id in your hand-back's done rows, with a pointer.\n\n${lines}`
}
