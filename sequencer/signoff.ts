import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { parse } from '../rails/diff.ts'
import { approve, batch, refuse, type Card } from '../cli/batch.ts'
import type { Answer, Desk, Seen } from '../cli/gh.ts'
import { notify, record, type Event, type Kind } from '../cli/inbox.ts'
import type { Db } from '../store/index.ts'
import { ENTER, needsCeo, PlanRow, rewind } from '../store/plans.ts'
import { clear } from '../store/refusals.ts'
import type { Board } from '../rails/ci-green/index.ts'
import { BOARD, headOf, opened, title } from './push.ts'
import { diffOf, drop, FORK, get, maybe, put, repoName } from './workspace.ts'

/**
 * 09-21 item 4: an outside job is signed off without a terminal. A plan waiting at step 7 gets one
 * card, an issue on our own repo, and a label answers it: `go` signs the head the card shows, `no`
 * refuses it -- with the CEO's comment it goes back to the builder, without one it waits for the
 * COO -- and `talk` hands it to the COO and leaves the card open. The card is for one head: a new
 * round closes it and opens the next, so a label only ever signs the bytes its card showed.
 */
export interface Signed { plan: number; card: number; did: 'opened' | Answer | 'superseded' | 'withdrawn' | 'shut' }

const FILE = 'signoff'

/**
 * Step 2 is the build in templates/pr-path.ts: the CEO's words go to whoever can change the code. The
 * approval row's reason is a slug (`approvals.reason` is checked); the words themselves go in `refusal.md`.
 */
const BUILD = 2

interface Kept { no: number; digest: string; url: string; shut: boolean }

export function signoffs(db: Db, root: string, desk: Desk, now: Date = new Date()): Signed[] {
  const cards = batch(db, root).filter((c) => c.kind === 'plan' && waiting(db, c))
  const live = new Set(cards.map((c) => c.id))
  const gone = carded(db, root).filter((id) => !live.has(id)).map((id) => withdraw(db, root, id, desk))
  return [...gone.filter((s) => s !== null), ...cards.flatMap((c) => one(db, root, c, desk, now))]
}

/** An outside plan whose checkout still holds the head the ready gate proved: the only head a label can sign. */
function waiting(db: Db, card: Card): boolean {
  const plan = planOf(db, card.id)
  return plan.origin === null && plan.target_id !== null && plan.head_digest === card.digest
}

function one(db: Db, root: string, card: Card, desk: Desk, now: Date): Signed[] {
  const kept = keptOf(root, card.id)
  if (kept !== null && kept.digest !== card.digest) {
    if (!kept.shut) desk.close(kept.no, 'Superseded: a new round changed the head. The next card replaces this one.')
    return [{ plan: card.id, card: kept.no, did: 'superseded' }, opening(db, root, card, desk, now)]
  }
  if (kept === null) return [opening(db, root, card, desk, now)]
  if (kept.shut) return []
  const seen = desk.seen(kept.no)
  if (seen.answer !== null) return [answered(db, root, card, kept, { ...seen, answer: seen.answer }, desk, now)]
  if (seen.open) return []
  save(root, card.id, { ...kept, shut: true })
  tell(root, card, 'asked', `the card was closed without an answer: ${kept.url}`, now)
  return [{ plan: card.id, card: kept.no, did: 'shut' }]
}

function answered(db: Db, root: string, card: Card, kept: Kept, seen: Seen & { answer: Answer }, desk: Desk, now: Date): Signed {
  const close = (comment: string): void => { if (seen.open) desk.close(kept.no, comment) }
  if (seen.answer === 'go') {
    approve(db, root, 'plan', card.id)
    db.prepare(`UPDATE plans SET state = ${ENTER} WHERE id = ? AND state = 'blocked_on_ceo'`).run(card.id)
    close(`Signed at ${card.digest.slice(0, 12)}. It goes out on the next tick.`)
    drop(root, card.id, FILE)
  } else if (seen.answer === 'talk') {
    desk.unlabel(kept.no, 'talk')
    tell(root, card, 'asked', `wants to talk about it: ${kept.url}${seen.words === null ? '' : ` (${flat(seen.words)})`}`, now)
  } else {
    refuse(db, root, 'plan', card.id, seen.words === null ? 'signoff.no_words' : 'signoff.no')
    if (seen.words === null) {
      needsCeo(db, planOf(db, card.id))
      save(root, card.id, { ...kept, shut: true })
      close('Refused with no words, so it waits for the COO.')
      tell(root, card, 'asked', `refused at sign-off with no words: ${kept.url}`, now)
    } else {
      db.transaction(() => { clear(db, card.id); rewind(db, card.id, BUILD) })()
      put(root, card.id, 'refusal.md', said(kept.url, seen.words))
      put(root, card.id, 'issue.md', ruled(get(root, card.id, 'issue.md'), seen.words, now.toISOString().slice(0, 10)))
      close('Refused. It goes back to the builder with your words, and they are now part of its brief; a new card comes with the next round.')
      drop(root, card.id, FILE)
      tell(root, card, 'refused', `back to the builder: ${flat(seen.words)}`, now)
    }
  }
  return { plan: card.id, card: kept.no, did: seen.answer }
}

function opening(db: Db, root: string, card: Card, desk: Desk, now: Date): Signed {
  const made = desk.open(titleFor(db, root, card.id), bodyFor(db, root, card))
  save(root, card.id, { no: made.no, digest: card.digest, url: made.url, shut: false })
  tell(root, card, 'signoff', `sign it off: ${made.url}`, now)
  return { plan: card.id, card: made.no, did: 'opened' }
}

/** A card whose plan left step 7 some other way -- signed at the terminal, or sent back for a round -- is closed, not left to be answered. */
function withdraw(db: Db, root: string, id: number, desk: Desk): Signed | null {
  const kept = keptOf(root, id)
  if (kept === null) return null
  const signed = db.prepare(`SELECT 1 FROM approvals WHERE subject_kind = 'plan' AND subject_id = ? AND subject_digest = ?
    AND decision = 'approved'`).get(id, kept.digest) !== undefined
  if (!kept.shut) {
    desk.close(kept.no, signed ? 'Signed at the terminal; this card is done.'
      : 'Withdrawn: the job went back for another round before an answer. A new card comes with it.')
  }
  drop(root, id, FILE)
  return { plan: id, card: kept.no, did: 'withdrawn' }
}

interface Subject { repo: string; issue_no: number; part: string }

function subjectOf(db: Db, plan: number): Subject {
  const row = db.prepare('SELECT t.repo, t.issue_no, t.part FROM plans p JOIN targets t ON t.id = p.target_id WHERE p.id = ?')
    .get(plan) as Subject | undefined
  if (row === undefined) throw new Error(`plan ${String(plan)} has no target row`)
  return row
}

/** No `owner/repo#n` and no upstream url anywhere a reference is read: our repo is public, and either would put a line on their thread. */
function titleFor(db: Db, root: string, plan: number): string {
  const s = subjectOf(db, plan)
  return `Sign-off: ${repoName(s.repo)} ${String(s.issue_no)}${s.part === '' ? '' : ` ${s.part}`}, ${title(root, plan)}`
}

/**
 * Everything the CEO judges on, readable on a phone: what it is, what it changes, what passed, the
 * commit on our fork, and the words the maintainer will read, fenced so no mention or reference in
 * them pings anyone or links anything before he says go.
 */
export function bodyFor(db: Db, root: string, card: Card): string {
  const s = subjectOf(db, card.id)
  const head = headOf(root, card.id)
  const open = opened(db, card.id)
  const fork = `${FORK}/${repoName(s.repo)}`
  const ci = boardOf(root, card.id)
  const text = open === null ? card.text : lastMessage(head.dir)
  const fence = '`'.repeat(Math.max(3, longest(text) + 1))
  return [
    `**${repoName(s.repo)} ${String(s.issue_no)}**: ${title(root, card.id)}`,
    '',
    headline(card.marks.every((m) => m.ok), ci),
    '',
    `- Upstream: ${code(s.repo)} issue ${code(String(s.issue_no))}, written as code so this card leaves no mark on their thread`,
    `- Change: ${card.change.trim().split('\t').join(', ')}; [the commit on our fork](https://github.com/${fork}/commit/${head.sha})`,
    `- Gates: ${card.marks.map((m) => `${m.name} ${m.ok ? 'pass' : 'NOT PASSED'}`).join(', ')}`,
    ...modes(root, card.id),
    ...(ci === null ? [] : [`- Their CI on our fork: ${ciLine(ci)}`]),
    open === null
      ? `- Goes out as: a new pull request titled ${code(title(root, card.id))}`
      : `- Goes out as: a follow-up commit on our open pull request ${code(open)}`,
    '',
    open === null ? '**What the maintainer reads**' : '**The commit message the maintainer reads**',
    '',
    `${fence}markdown`,
    text,
    fence,
    '',
    ...unsaid(root, card.id, open === null ? text : null),
    '**Answer with one label.** `go` sends it. `no` refuses it: comment first and the builder reworks against your words. `talk` hands it to the COO.',
    '',
    `<sub>plan ${String(card.id)}, head ${head.sha.slice(0, 12)}, digest ${card.digest.slice(0, 12)}</sub>`,
    '',
  ].join('\n')
}

/**
 * #97: PR text written in advance (`cf queue add --pr`) can leave out a file the build changed. The card names
 * each one the text never mentions, by path or by name, so the gap is seen before `go`.
 */
function unsaid(root: string, plan: number, text: string | null): string[] {
  if (text === null || maybe(root, plan, 'pr.md') === null) return []
  const left = parse(diffOf(root, plan)).map((f) => f.path).filter((p) => !text.includes(p) && !text.includes(basename(p)))
  return left.length === 0 ? [] : [`**Not in the PR text:** ${left.map((p) => code(p)).join(', ')}`, '']
}

function modes(root: string, plan: number): string[] {
  const named = ([[4, 'review'], [5, 'senior_review']] as const).flatMap(([step, gate]) => {
    const mode = maybe(root, plan, `step-${String(step)}.mode`)
    return mode === null ? [] : [`${gate} ${mode.trim()}`]
  })
  return named.length === 0 ? [] : [`- Review mode: ${named.join('; ')}`]
}

/** Green is said only of what finished green: a workflow the gate did not judge is still on the card, and still counts here. */
function headline(passed: boolean, ci: Board[] | null): string {
  if (!passed) return 'Waiting on you, but not every gate passed: read the marks first.'
  if (ci === null) return 'Waiting on you. The four gates passed.'
  const off = ci.filter((r) => state(r) !== 'green').length
  if (off === 0) return 'Waiting on you. The four gates passed and every one of their workflows is green on our fork.'
  return `Waiting on you. The four gates passed, but ${String(off)} of their workflows ${off === 1 ? 'is' : 'are'} not green: read the CI line first.`
}

function ciLine(ci: Board[]): string {
  const judged = ci.filter((r) => r.gates)
    .map((r) => r.base === undefined ? `${r.workflow} ${state(r)}` : `${r.workflow} red on the base too (${r.base.join(', ')})`)
  const rest = ci.filter((r) => !r.gates).map((r) => `${r.workflow} ${state(r)}`)
  return rest.length === 0 ? judged.join(', ') : `${judged.join(', ')}; also ran, not judged on: ${rest.join(', ')}`
}

function state(r: Board): string {
  if (r.status !== 'completed') return 'still running'
  return r.conclusion === 'success' ? 'green' : r.conclusion === 'failure' ? 'red' : r.conclusion
}

function boardOf(root: string, plan: number): Board[] | null {
  const saved = maybe(root, plan, BOARD)
  return saved === null ? null : JSON.parse(saved) as Board[]
}

function lastMessage(dir: string): string {
  return execFileSync('git', ['log', '-1', '--format=%B'], { cwd: dir, encoding: 'utf8' }).trimEnd()
}

function longest(text: string): number {
  return Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
}

function code(text: string): string {
  const tick = '`'.repeat(longest(text) + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${tick}${pad}${text}${pad}${tick}`
}

/**
 * The CEO's `no` with words joins the brief: a D row the builder must answer and a Must not break line the
 * reviewers hold. `refusal.md` carries them for one round; the brief carries them for every round after it.
 */
export function ruled(brief: string, words: string, day: string): string {
  const said = `The CEO's ruling at sign-off (${day}): ${words.replace(/\s+/g, ' ').trim()}`
  const next = Math.max(0, ...[...brief.matchAll(/^\s*[-*]\s*\**D(\d+)/gm)].map((m) => Number(m[1]))) + 1
  const lines = brief.trimEnd().split('\n')
  const cased = under(lines, '## Cases', `- D${String(next)} ${said}`)
  const held = under(lines, '## Must not break', `- ${said}`)
  if (!cased && !held) lines.push('', "## The CEO's rulings", '', `- D${String(next)} ${said}`)
  return `${lines.join('\n')}\n`
}

/** Adds `line` as the last bullet of the section under `heading`; false where the brief has no such section. */
function under(lines: string[], heading: string, line: string): boolean {
  const from = lines.findIndex((l) => l.trimEnd() === heading)
  if (from === -1) return false
  const next = lines.findIndex((l, i) => i > from && l.startsWith('## '))
  let at = next === -1 ? lines.length : next
  while (at > from + 1 && (lines[at - 1] ?? '').trim() === '') at -= 1
  lines.splice(at, 0, line)
  return true
}

function said(url: string, words: string): string {
  return `the CEO on the sign-off card ${url}:\n\n${words}\n\nspans:\n  - signoff\n`
}

function flat(words: string): string {
  return words.replace(/\s+/g, ' ').slice(0, 140)
}

function tell(root: string, card: Card, kind: Kind, note: string, now: Date): void {
  const event: Event = { at: now.toISOString(), plan: card.id, ticket: card.title.split(' ')[0] ?? `plan ${String(card.id)}`,
    kind, step: 7, name: 'sign-off', note }
  record(root, [event])
  notify([event])
}

function planOf(db: Db, id: number): PlanRow {
  return PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = ?').get(id))
}

function carded(db: Db, root: string): number[] {
  return (db.prepare('SELECT id FROM plans WHERE origin IS NULL AND target_id IS NOT NULL ORDER BY id').all() as { id: number }[])
    .map((r) => r.id).filter((id) => maybe(root, id, FILE) !== null)
}

function keptOf(root: string, plan: number): Kept | null {
  const line = maybe(root, plan, FILE)?.trim()
  if (line === undefined || line === '') return null
  const [no, digest, url, shut] = line.split(' ')
  return { no: Number(no), digest: digest ?? '', url: url ?? '', shut: shut === 'shut' }
}

function save(root: string, plan: number, kept: Kept): void {
  put(root, plan, FILE, `${String(kept.no)} ${kept.digest} ${kept.url}${kept.shut ? ' shut' : ''}\n`)
}
