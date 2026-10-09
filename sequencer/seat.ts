import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { map } from '../cli/map.ts'
import type { Fired, Provider } from '../providers/kind.ts'
import { packet, refuse } from '../runner/index.ts'
import { reviewManifest, SYMBOLS_LEAD, type Bench } from '../runner/packet.ts'
import { load, seat, tight, type Seat } from '../runner/rules.ts'
import { judge, loadReviews } from '../reviews/bench.ts'
import { coverage, type Gated } from '../reviews/package.ts'
import type { Finding, Judged, Note } from '../reviews/verdict.ts'
import { regated } from '../store/dispositions.ts'
import { logged, runLogged, type Run } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { filesOf } from '../store/files.ts'
import { due, keep } from '../store/language-notes.ts'
import { profile } from '../store/profile.ts'
import { observed, wall } from '../store/lanes.ts'
import { briefed, builderRan, internal, type PlanRow } from '../store/plans.ts'
import { byRun, opened, pending, unfinished } from '../store/transcript.ts'
import type { Step } from '../templates/pr-path.ts'
import { parse } from '../rails/diff.ts'
import { estimate, human, pointed, references, section, shape, split, TEMPLATE, unclear, wide, WIDE, type Part } from './brief.ts'
import { repoOf } from './ready.ts'
import { limitOf } from './size.ts'
import { handout, long, touched, type Handed } from './handout.ts'
import { capped, enclosed, handover, type Handover } from './handover.ts'
import { symbolMap } from './symbols.ts'
import { targetOf } from './steps.ts'
import { install, mode, type Mode } from './checks.ts'
import { narrow } from './rails.ts'
import { classify } from './delta.ts'
import { commanded } from './command.ts'
import { looked } from './design.ts'
import { deletions } from './fence.ts'
import { asked, findings } from './findings.ts'
import { fenceFor, languageFor } from './route.ts'
import { languages } from './split.ts'
import { staffed } from './staffing.ts'
import { gates, outsideLanguage } from './gates.ts'
import type { Outcome } from './kind.ts'
import { landed } from './notes.ts'
import { COMMIT, commitMessage } from './push.ts'
import { carried, cloned, diffOf, diffSince, doneIds, drop, get, headSha, holds, MAIN, maybe, merging, move, narrowing, planDir, put, ruled, rulings, snapshot, srcDir } from './workspace.ts'
import { kernelPlan } from './home.ts'
import { READ, SERVER, server } from './upstream.ts'
import { audit } from '../rails/completion-audit/index.ts'

const FENCE = /^---\r?\n[\s\S]*?\r?\n---\s*$/m

export async function fireSeat(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  if (step.step === 2 && maybe(root, plan.id, 'issue.md') === null) {
    return { outcome: 'pass', spans: [], note: `${step.runs}: no issue.md to build from; back to the brief`, rewind: 1 }
  }
  if (kernelPlan(plan)) install(srcDir(root, plan.id))
  const name = `step-${String(step.step)}.handback.md`
  const prev = maybe(root, plan.id, name)
  if (prev !== null) put(root, plan.id, `step-${String(step.step)}.handback.prev.md`, prev)
  const issue = handed(rebuild(db, root, plan, prev), symbolSection(db, root, plan))
  const fired = await ran(db, root, plan, step, provider, issue, kernelPlan(plan))
  if (step.step === 2) marked(db, root, plan.id)
  put(root, plan.id, name, fired.text)
  const tokens = fired.usage.input + fired.usage.cache + fired.usage.output
  if (fired.ended !== 'completed') return exited(step, fired)
  const kept = await fenced(db, root, plan, step, provider, fired.text)
  if (typeof kept !== 'string') return kept
  return dropped(db, root, plan, step, kept)
    ?? empty(root, plan, step, kept)
    ?? { outcome: 'pass', spans: [], note: `${step.runs} exit 0, ${String(tokens)} tokens` }
}

function marked(db: Db, root: string, plan: number): void {
  const run = db.prepare('SELECT transcript_path FROM runs WHERE plan = ? AND step = 2 ORDER BY id DESC LIMIT 1')
    .get(plan) as { transcript_path: string | null } | undefined
  const command = unfinished(run?.transcript_path ?? '')
  if (command === null) drop(root, plan, 'step-2.unfinished.md')
  else put(root, plan, 'step-2.unfinished.md', command)
}

/** A step-2 hand-back with no fence, or one whose YAML does not parse, is asked once for the fence alone. */
async function fenced(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider, text: string): Promise<string | Outcome> {
  if (step.step !== 2 || (FENCE.test(text) && audit(text, []).outcome === 'pass')) return text
  const before = diffOf(root, plan.id)
  const ids = doneIds(get(root, plan.id, 'issue.md')).join(', ')
  const ask = `# Your hand-back\n\n${text}\n\nWrite only the closing \`---\` fence, with a \`done:\` row for each of ${ids}. Edit no file.`
  const again = await ran(db, root, plan, step, provider, ask, kernelPlan(plan))
  if (again.ended !== 'completed') return exited(step, again)
  if (diffOf(root, plan.id) !== before) {
    return { outcome: 'refuse', spans: ['step-2.handback.md'], note: `${step.runs}: the fence re-ask edited the tree` }
  }
  const fence = FENCE.exec(again.text)?.[0]
  if (fence === undefined) return text
  const kept = `${text.replace(FENCE, '').trimEnd()}\n\n${fence}`
  put(root, plan.id, 'step-2.handback.md', kept)
  return kept
}

/**
 * The build names paths under `## Deleted` and the kernel removes them, before the rails read the
 * tree; `git add -A` at the commit stages the removal, so the deletion is in the diff the reviewers
 * judge. The fence that bars a write bars a delete -- the same `refuse()` the seat's own tools run
 * through -- and a path that is not there refuses rather than passing as a silent no-op.
 */
function dropped(db: Db, root: string, plan: PlanRow, step: Step, handback: string): Outcome | null {
  const { paths, unread } = deletions(handback)
  if (unread.length > 0) return { outcome: 'refuse', spans: unread, note: `${step.runs}: ${unread.map((r) => `${r} names no path`).join('; ')}` }
  if (paths.length === 0) return null
  const src = srcDir(root, plan.id)
  const fence = fenceFor(db, plan.id, seat(root, step.runs).manifest.write_paths)
  const barred = paths.filter((path) => refuse(src, fence, path, kernelPlan(plan)) !== null)
  const absent = paths.filter((path) => !barred.includes(path) && !existsSync(join(src, path)))
  if (barred.length > 0 || absent.length > 0) {
    const why = [...barred.map((p) => `${p} is outside the fence`), ...absent.map((p) => `${p} is not in the tree`)]
    return { outcome: 'refuse', spans: [...barred, ...absent], note: `${step.runs}: ${why.join('; ')}` }
  }
  for (const path of paths) rmSync(join(src, path))
  return null
}

function empty(root: string, plan: PlanRow, step: Step, handback: string): Outcome | null {
  if (step.step !== 2 || FENCE.test(handback) || diffOf(root, plan.id).trim() !== '') return null
  const note = `${step.runs}: the build changed no file and handed back no fence; a file the ask removes goes under \`## Deleted\``
  return { outcome: 'refuse', spans: ['step-2.handback.md'], note }
}

/**
 * Step 1. The seat's reply is the brief, and the machine is what saves it: everything downstream reads
 * `issue.md` and so works from the brief; only the builder also gets what ask.md gained since (`ruled`). A plan a builder has already run on keeps
 * the ticket it was built against, whatever its shape, and a brief that still passes stands, so the
 * contract the reviewers read does not move under them between rebuild rounds.
 */
export async function fireBrief(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  const ticket = maybe(root, plan.id, 'issue.md')
  if (ticket === null && maybe(root, plan.id, 'ask.md') === null) {
    return { outcome: 'needs_ceo', spans: ['ask.md'], note: `plan ${String(plan.id)} has no ask.md or issue.md: write the ask to ask.md, then cf retry ${String(plan.id)}` }
  }
  if (ticket !== null && builderRan(db, plan.id)) return stands()
  const saved = split(maybe(root, plan.id, 'split.md') ?? '')
  if (saved !== null) return splitting(step, saved)
  const ask = askOf(root, plan.id)
  const src = srcDir(root, plan.id)
  const standing = maybe(root, plan.id, 'issue.md')
  if (standing !== null && shape(standing, ask, src, !internal(plan)) === null) return stands()
  const fired = await ran(db, root, plan, step, provider, again(db, root, plan.id, ask) + store(root, plan) + seams(root, plan.seat) + long(src) + wideAsk(ask), false)
  drop(root, plan.id, 'brief.refused.md')
  if (fired.ended !== 'completed') return exited(step, fired)
  const line = commanded(fired.text)
  if (line !== null) return { outcome: 'pass', spans: [], note: `${step.runs}: ${line}`, command: line }
  const question = unclear(fired.text)
  if (question !== null) return asking(root, plan.id, step, question)
  const refused = shape(fired.text, ask, src, !internal(plan))
  const reply = refused === null ? languages(plan, fired.text) ?? fired.text : fired.text
  const parts = split(reply)
  if (parts !== null) {
    put(root, plan.id, 'split.md', reply)
    return splitting(step, parts)
  }
  const over = refused === null ? oversized(db, plan, fired.text) : null
  if (refused !== null || over !== null) put(root, plan.id, 'brief.refused.md', fired.text)
  if (refused !== null) return { outcome: 'refuse', spans: [refused.span], note: `${step.runs}: ${refused.reason}` }
  if (over !== null) return { outcome: 'refuse', spans: ['brief.wide'], note: `${step.runs}: ${over}, so answer with the split fence` }
  briefed(db, plan.id, human(fired.text))
  put(root, plan.id, 'issue.md', fired.text)
  put(root, plan.id, 'ask.briefed.md', ask)
  const message = commitMessage(root, plan)
  if (message !== null) put(root, plan.id, COMMIT, message)
  drop(root, plan.id, 'refusal.md')
  drop(root, plan.id, 'question.sha')
  return { outcome: 'pass', spans: [], note: `${step.runs}: brief written` }
}

function oversized(db: Db, plan: PlanRow, brief: string): string | null {
  const width = wide(brief)
  if (width !== null) return `the brief touches ${String(width)} files besides tests; past ${String(WIDE)} it is more than one job`
  if (internal(plan)) return null
  const repo = repoOf(db, plan)
  const lines = estimate(brief)
  if (repo === null || lines === null) return null
  const limit = limitOf(db, repo)
  return lines > limit ? `the brief estimates ${String(lines)} lines besides tests and generated files; past ${repo}'s ${String(limit)} it is more than one job` : null
}

/** Only the ask's own text counts: a part carrying a wide parent's ticket told to split again would loop. */
function wideAsk(ask: string): string {
  const lines = ask.split('\n')
  const parent = lines.findIndex((l) => l === '## Parent ticket' || l === '## Parent comments')
  const width = wide((parent === -1 ? lines : lines.slice(0, parent)).join('\n'))
  if (width === null) return ''
  return `\n\n# More than one job\n\nThe ask names ${String(width)} files besides tests under \`## Files\`; past ${String(WIDE)} it is more than one job: answer with the split fence and write no brief.\n`
}

/** The answer is kept until it is filed, so a `gh` that fails half way does not buy a second brief. */
function splitting(step: Step, parts: Part[]): Outcome {
  return { outcome: 'pass', spans: [], note: `${step.runs}: ${String(parts.length)} jobs, not one`, parts }
}

function stands(): Outcome {
  return { outcome: 'pass', spans: [], note: 'the brief stands' }
}

function asking(root: string, plan: number, step: Step, question: string): Outcome {
  if (maybe(root, plan, 'refusal.md') !== null) move(root, plan, 'refusal.md', 'refusal.prev.md')
  put(root, plan, 'question.md', `${question}\n`)
  const base = maybe(root, plan, 'base.sha')
  if (base !== null) put(root, plan, 'question.sha', base)
  return { outcome: 'needs_ceo', spans: [], note: `${step.runs}: ${question}` }
}

function again(db: Db, root: string, plan: number, ask: string): string {
  const refusal = maybe(root, plan, 'refusal.md')
  const last = maybe(root, plan, 'brief.refused.md')
  const asked = `${ask}\n\n${TEMPLATE}`
  if (refusal === null) return `${asked}${lastQuestion(db, root, plan)}`
  if (last === null) return `${asked}\n# Refused — write the whole brief again, fixing this\n\n${refusal}`
  return `${asked}\n# Your last brief\n\n${last}\n# Refused — fix what this names, keep every other line\n\n${refusal}`
}

/** `cf return` recut the checkout from today's main, which holds `question.sha` as an ancestor. */
function lastQuestion(db: Db, root: string, plan: number): string {
  const question = maybe(root, plan, 'question.prev.md')
  const sha = maybe(root, plan, 'question.sha')?.trim()
  const src = srcDir(root, plan)
  if (question === null || sha === undefined || !holds(src, sha)) return ''
  const run = db.prepare('SELECT transcript_path FROM runs WHERE plan = ? AND step = 1 ORDER BY id DESC LIMIT 1')
    .get(plan) as { transcript_path: string | null } | undefined
  const paths = [...new Set(opened(run?.transcript_path ?? '').map((path) => relative(src, path)))]
    .filter((path) => path !== '' && !path.startsWith('..'))
  if (paths.length === 0) return ''
  const incoming = new Set(merging(src, sha, MAIN).incoming)
  const rows = paths.map((path) => `- ${path} — ${incoming.has(path) ? 'changed on main since' : 'unchanged'}`)
  return `\n# Your last question\n\n${question}\n# Files you opened last time\n\n${rows.join('\n')}\n`
}

/** Atelier reads cf.db, so its brief writer may read the machine's schema and CLI, read-only. */
export function machineReads(root: string, plan: PlanRow, seat: string): string[] {
  return plan.lane === 'atelier' && seat === 'brief_writer' ? [join(root, 'schema'), join(root, 'cli')] : []
}

/** Dashboard jobs run side by side, so each section keeps to its own files. */
const DASHBOARD = '\n# Dashboard layout\n\nEach dashboard section owns its files: a view in `Atelier/Views/Dashboard/`, its query as an extension on `DashboardSource` in `Atelier/Services/Dashboard/`, its models in `Atelier/Models/Dashboard/`, and its tests in `AtelierTests/Dashboard/`. A new table, chart or row gets new files there; only `Atelier/Views/DashboardView.swift` composes the sections, with one line per section. Do not add dashboard state or queries to `CFQueueStore`, and do not put a new section in another section\'s files.\n'

function store(root: string, plan: PlanRow): string {
  const [schema, cli] = machineReads(root, plan, 'brief_writer')
  if (schema === undefined || cli === undefined) return ''
  return `\n\n# The machine's store\n\nAtelier reads the machine's cf.db. Its tables are defined in \`${schema}/*.sql\` (later files alter earlier ones) and the \`cf\` commands in \`${cli}/\`. Read them for column names and values; you may not write there.\n${DASHBOARD}`
}

function seams(root: string, seat: string | null): string {
  const path = seat === null ? null : join(root, 'seats', seat, 'prompt.md')
  const body = path === null || !existsSync(path) ? '' : section(readFileSync(path, 'utf8'), '## Seams').trim()
  return body === '' ? '' : `\n\n# Seams\n\n${body}\n`
}

/** A plan with no `ask.md` carries its ask as `issue.md`, the name the brief takes over. */
function askOf(root: string, plan: number): string {
  return maybe(root, plan, 'ask.md') ?? move(root, plan, 'issue.md', 'ask.md')
}

export async function ran(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider,
  issue: string, ours: boolean): Promise<Fired> {
  load(db, root)
  const { manifest, prompt, hash } = seat(root, step.runs, step.mode)
  const src = srcDir(root, plan.id)
  const built = packet(manifest, prompt + noteSection(db, root, plan, step), tight(root), issue, src,
    transcriptOf(root, plan.id, step.step), ours, fenceFor(db, plan.id, manifest.write_paths))
  const staffing = staffedOn(db, root, plan, step.step)
  const fired = await provider.fire({
    ...built,
    ...(step.runs === 'brief_writer' ? { tools: [...built.tools, READ], servers: { [SERVER]: server(db, plan.id) } } : {}),
    prompt: `${map(src)}\n\n${built.prompt}`,
    wall: wall(db),
    reads: machineReads(root, plan, step.runs),
  })
  recorded(db, plan.id, step.step, step.runs, hash, provider.name, manifest, fired, step.mode, staffing)
  observed(db, fired.limits)
  return fired
}

export function recorded(db: Db, plan: number, step: number, name: string, hash: string, provider: Provider['name'],
  manifest: Seat, fired: Fired, mode?: Run['mode'], staffed?: string): void {
  const id = runLogged(db, { plan, step, seat: name, rule_hash: hash, provider, model: manifest.model,
    effort: manifest.effort, exit: fired.exit, fired, mode, staffed })
  byRun(db, id, fired.transcript_path)
}

function staffedOn(db: Db, root: string, plan: PlanRow, step: number): string | undefined {
  if (plan.template === 'research') return undefined
  return staffed(root, plan.template, step, plan.template === 'pr_path' ? languageFor(db, plan, srcDir(root, plan.id)) : null)?.seat
}

function exited(step: Step, fired: Fired): Outcome {
  return { outcome: 'refuse', spans: [fired.stop_reason ?? 'seat.exit'], note: `${step.runs} ${fired.ended}` }
}

/**
 * The builder's packet: the brief and the text of the files it lists; on a rebuild, the spans the
 * refusal named, the rows its last hand-back claimed, the builder's own diff so far, and the text of only
 * the files those touch. After a re-cut from main the diff is the one carried across and the files are main's,
 * so the packet says to re-apply rather than to carry on: the builder is looking at a tree that has none
 * of its work in it.
 */
function rebuild(db: Db, root: string, plan: PlanRow, prev: string | null): string {
  const src = srcDir(root, plan.id)
  const ruling = ruled(root, plan.id)
  const issue = get(root, plan.id, 'issue.md') + rulings(root, plan.id) + (ruling === null ? '' : `\n\n# What the ask holds beyond this brief\n\n${ruling.trim()}`) + findings(db, root, plan.id, src) + asked(db, plan.id)
  const refusal = maybe(root, plan.id, 'refusal.md')
  const rows = lastRows(prev)
  if (refusal === null) return handed(`${issue}${rows}`, handout(src, listed(db, plan.id, issue)))
  const diff = diffOf(root, plan.id)
  if (stopped(refusal) && carried(root, plan.id) === null) return resumed(db, src, plan.id, `${issue}${rows}`, diff)
  const again = `${issue}\n\n# Refused — rebuild only these spans\n\n${refusal}${rows}`
  const since = diff.trim() === '' ? again : `${again}\n\n# ${headed(root, plan.id)}\n\n\`\`\`\`diff\n${diff}\n\`\`\`\``
  return handed(since, handout(src, touched(diff, refusal)))
}

/** A build the wall or an exit cut short was never judged: the refusal names the stop, not a fault in the work. */
export function stopped(refusal: string): boolean {
  return /^step \d+ build refused by \S+\n\n\S+ stopped\n/.test(refusal)
}

/**
 * The work a stopped fire left in the tree is kept, and the next fire is told so: it is handed what it
 * has not written yet, not the files it already changed, so it finishes instead of starting over.
 */
function resumed(db: Db, src: string, plan: number, issue: string, diff: string): string {
  const listing = listed(db, plan, issue)
  if (diff.trim() === '') return handed(issue, handout(src, listing))
  const done = new Set(parse(diff).map((f) => f.path))
  const left = filesOf(db, plan).map((f) => f.path).filter((p) => !done.has(p))
  const rest = left.length === 0 ? '' : ` Not written yet: ${left.map((p) => `\`${p}\``).join(', ')}.`
  const head = '# Your last fire stopped before it finished\n\nThe diff below is your work so far and the checkout holds it. '
    + `Keep it: do not re-read or rewrite what it holds. Finish what is left.${rest} Answer every D row the diff does not answer yet.`
  return handed(`${issue}\n\n${head}\n\n\`\`\`\`diff\n${diff}\n\`\`\`\``, handout(src, listing.filter((f) => !done.has(f.path))))
}

/** The rows the last fence claimed: a rebuild's own fence answers every case, not only the ones it touched. */
function lastRows(prev: string | null): string {
  const done = /^---\r?\n[\s\S]*?^(done:[\s\S]*?)\r?\n---\s*$/m.exec(prev ?? '')?.[1]
  return done === undefined ? '' : `\n\n# Your last hand-back — carry these rows forward, updating the ones you rebuild\n\n${done}\n`
}

function headed(root: string, plan: number): string {
  return carried(root, plan) === null
    ? 'Your diff so far'
    : 'Main moved and your work conflicted with it, so the checkout was cut again from main — '
      + 'the files below are main\'s and hold none of your work. Re-apply this diff onto them'
}

/** The brief's files from the store, a new one left out, each with the lines the brief points it at. */
function listed(db: Db, plan: number, issue: string): Handed[] {
  const lines = pointed(issue)
  return filesOf(db, plan).filter((f) => !f.is_new).flatMap((f): Handed[] => {
    const at = lines.filter((l) => l.path === f.path)
    return at.length === 0 ? [{ path: f.path, line: null }] : at
  })
}

function handed(issue: string, files: string): string {
  return files === '' ? issue : `${issue}\n\n${files}`
}

/** The verdict and the notes beside it. */
interface Round {
  outcome: Outcome
  notes: Note[]
}

async function fireReview(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Round> {
  loadReviews(db, root)
  const manifest = reviewManifest(root, step.runs)
  const src = srcDir(root, plan.id)
  const issue = get(root, plan.id, 'issue.md')
  const input: Bench = manifest.gate === 'blind_review' ? blind(db, root, plan) : {
    repo: src,
    issue: issue + rulings(root, plan.id),
    diff: diffOf(root, plan.id),
    ...(cloned(src) ? { tree: snapshot(src) } : {}),
    ...(internal(plan) && maybe(root, plan.id, 'step-2.handback.md') !== null ? { handback: get(root, plan.id, 'step-2.handback.md') } : {}),
    ...outside(db, root, plan, src),
    ...(manifest.gate === 'senior_review' ? referenced(src, issue) : {}),
    ...checked(db, plan, src, diffOf(root, plan.id)),
    ...(manifest.reads_verdict ? { verdict: priorVerdict(root, plan.id) } : {}),
    ...(manifest.gate === 'review' ? senior(db, step.seat, plan.id) : {}),
    ...(manifest.gate === 'senior_review' && cloned(src) ? greptile(db, plan.id, headSha(src)) : {}),
    ...rounds(db, root, plan.id, step.step),
  }
  const as = step.mode === 'review' && internal(plan) === (step.seat === 'typescript_specialist') ? step.seat : undefined
  try {
    const { verdict, outcome } = await judge(db, root, step.runs, plan.id, input, provider, transcriptOf(root, plan.id, step.step), as,
      staffedOn(db, root, plan, step.step))
    if (outcome.outcome === 'pass') regated(db, plan.id, step.step, verdict, input.prior, input.tree)
    put(root, plan.id, `step-${String(step.step)}.verdict.md`, verdictText(outcome))
    if (outcome.outcome === 'pass' && input.tree !== undefined) put(root, plan.id, `step-${String(step.step)}.passed.diff`, input.diff)
    const asked = outcome.outcome === 'needs_ceo' && outcome.message !== '' ? `: ${outcome.message.replace(/\s+/g, ' ')}` : ''
    return {
      outcome: { outcome: outcome.outcome, spans: outcome.spans, note: `${step.runs} ${outcome.outcome}${asked}`, message: outcome.message },
      notes: outcome.notes,
    }
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error)
    return { outcome: { outcome: 'refuse', spans: ['reviewers.verdict_fence'], note: `${step.runs} ${note}` }, notes: [] }
  }
}

function landable(db: Db, plan: PlanRow, step: Step, notes: Note[]): Note[] {
  const language = notes.filter((n) => n.kind === 'language')
  for (const n of language) {
    logged(db, { plan: plan.id, kind: 'note', actor: step.runs, outcome: 'pass', message: `language: ${n.why}`, pointer: `${n.file}:${String(n.line)}`, run: null })
  }
  if (step.verdict_gate === 'senior_review') keep(db, plan.id, step.seat, language)
  return notes.filter((n) => n.kind !== 'language')
}

export async function fireLanded(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  const also = internal(plan) ? undefined : step.outside
  if (also !== undefined) await judge(db, root, also, plan.id, blind(db, root, plan), provider, transcriptOf(root, plan.id, step.step))
    .catch((error: unknown) => logged(db, { plan: plan.id, kind: step.name, actor: also, outcome: 'refuse', message: String(error), pointer: null, run: null }))
  const { outcome, notes: all } = await fireReview(db, root, plan, step, provider)
  const notes = landable(db, plan, step, all)
  const done = outcome.outcome === 'pass' && notes.length > 0 ? landed(db, root, plan, step, notes) : outcome
  return step.design === true && done.outcome === 'pass' ? looked(db, root, plan, provider) : done
}

/** On someone else's repository the reviewer is handed its footing instead of reading for it. */
function outside(db: Db, root: string, plan: PlanRow, src: string): Handover {
  const base = maybe(root, plan.id, 'base.sha')
  if (internal(plan) || base === null || !cloned(src)) return {}
  return { ...handover(src, base.trim()), ...symbolsOf(db, root, plan, src) }
}

/** A blind reviewer reads the change as the upstream maintainer would: no issue, brief or rulings. */
export function blind(db: Db, root: string, plan: PlanRow): Bench {
  const src = srcDir(root, plan.id)
  return { repo: src, diff: diffOf(root, plan.id), ...(cloned(src) ? { tree: snapshot(src) } : {}), ...outside(db, root, plan, src) }
}

function symbolsOf(db: Db, root: string, plan: PlanRow, src: string): Pick<Handover, 'symbols'> {
  const base = maybe(root, plan.id, 'base.sha')
  const target = targetOf(db, plan)
  if (internal(plan) || base === null || target === null || !cloned(src)) return {}
  const symbols = capped(symbolMap(root, target.repo, src, base.trim()))
  return symbols === undefined ? {} : { symbols }
}

function symbolSection(db: Db, root: string, plan: PlanRow): string {
  const { symbols } = symbolsOf(db, root, plan, srcDir(root, plan.id))
  return symbols === undefined ? '' : `# Symbols at the branch base\n\n${SYMBOLS_LEAD}\n\n${symbols}`
}

function noteSection(db: Db, root: string, plan: PlanRow, step: Step): string {
  const repo = step.step === 2 && !internal(plan) ? repoOf(db, plan) : null
  const notes = repo === null ? [] : profile(root, repo)?.notes ?? []
  return repo === null || notes.length === 0 ? '' : `\n\n# Notes on ${repo}\n\n${notes.map((n) => `- ${n}`).join('\n')}`
}

function referenced(src: string, issue: string): Pick<Bench, 'reference'> {
  const text = handout(src, references(issue))
  return text === '' ? {} : { reference: text }
}

/**
 * Step 3 already ran the checkout's own checks on this diff, or on a stranger's repo its language's gates;
 * the reviewer is told so rather than reasoning its way to it. Read off the rail's row, never re-run, and
 * only while the diff is the one it judged.
 */
export function checked(db: Db, plan: PlanRow, src: string, diff: string): { checks?: string } {
  const checks = coverage(gated(db, plan, src, diff), diff)
  return checks === undefined ? {} : { checks }
}

const LANGUAGE: Partial<Record<Mode, string>> = { npm: 'typescript', xcodebuild: 'swift', gradle: 'kotlin' }

function gated(db: Db, plan: PlanRow, src: string, diff: string): Gated[] {
  const row = db.prepare(`SELECT outcome, subject_digest FROM verdicts WHERE plan = ? AND kind = 'rail' AND rail_id = 'checks'
    ORDER BY id DESC LIMIT 1`).get(plan.id) as { outcome: string; subject_digest: string } | undefined
  if (row?.outcome !== 'pass' || row.subject_digest !== createHash('sha256').update(diff).digest('hex')) return []
  if (!internal(plan)) {
    const outside = outsideLanguage(languageFor(db, plan, src))
    if (outside === null) return []
    return gates(src, { language: outside, files: filesOf(db, plan.id).map((f) => f.path) })
      .map((g) => ({ language: outside, dir: g.dir, command: [g.bin, ...g.args].join(' ') }))
  }
  const language = LANGUAGE[mode(src)]
  if (language === undefined) return []
  const scope = narrow(db, plan).length > 0 ? 'the tests this plan\'s files reach' : 'the whole suite'
  return [{ language, dir: '', command: `every script the checkout names (${mode(src)}, ${scope})` }]
}

function senior(db: Db, seat: string, plan: number): Pick<Bench, 'language'> {
  const notes = due(db, seat, plan)
  return notes.length === 0 ? {} : { language: notes.map((n) => `- ${n.file}:${String(n.line)} ${n.why}: ${n.old} → ${n.new}`).join('\n') }
}

function greptile(db: Db, plan: number, head: string): Pick<Bench, 'bot'> {
  const row = db.prepare(`SELECT body FROM signals WHERE plan = ? AND kind = 'bot_review' AND head = ? AND body IS NOT NULL
    ORDER BY id DESC LIMIT 1`).get(plan, head) as { body: string } | undefined
  return row === undefined ? {} : { bot: row.body }
}

/** From a reviewer's second round on: the verdict it wrote last round, the refusal that sent the build back, and what the tree did since the one it judged. */
function rounds(db: Db, root: string, plan: number, step: number): Pick<Bench, 'prior' | 'refusal' | 'since' | 'narrowing'> {
  const last = maybe(root, plan, `step-${String(step)}.verdict.md`)
  if (last === null) return {}
  const refusal = maybe(root, plan, 'refusal.md')
  const prior = { prior: last, ...(refusal === null ? {} : { refusal }) }
  const tree = judged(db, plan, step)
  const src = srcDir(root, plan)
  if (tree === null || !holds(src, tree)) return prior
  // Before enclosed(): diffSince's `add -A --intent-to-add` is what puts new files in enclosed()'s diff.
  const plain = diffSince(src, tree)
  const paths = narrowing(src, tree, get(root, plan, 'base.sha').trim())
  const { mode, why } = classify(maybe(root, plan, `step-${String(step)}.passed.diff`), plain, paths.changed)
  put(root, plan, `step-${String(step)}.mode`, `${mode}: ${why}\n`)
  return mode === 'full' ? prior : { ...prior, since: enclosed(src, tree) ?? plain, narrowing: paths }
}

/** The tree the reviewer last passed, else the one its last verdict judged, off the row `judge()` wrote it on. */
function judged(db: Db, plan: number, step: number): string | null {
  const row = db.prepare(`SELECT tree FROM verdicts WHERE plan = ? AND step = ? AND kind = 'review' AND gate <> 'blind_review'
    ORDER BY outcome = 'pass' AND tree IS NOT NULL DESC, id DESC LIMIT 1`)
    .get(plan, step) as { tree: string | null } | undefined
  return row?.tree ?? null
}

function transcriptOf(root: string, plan: number, step: number): string {
  return pending(planDir(root, plan), `step-${String(step)}`)
}

/** Step 5 is the second reviewer reading the first one's verdict. */
function priorVerdict(root: string, plan: number): string {
  return maybe(root, plan, 'step-4.verdict.md') ?? 'the first reviewer left no verdict'
}

function verdictText(v: Judged): string {
  const defect = v.defect_class === null ? '' : `class: ${v.defect_class}\n`
  return `---\noutcome: ${v.outcome}\n${defect}spans:\n${v.findings.map(entry).join('\n')}\n---\n\n${v.message}\n`
}

/** A plain finding is the bare span; a cosmetic one carries its kind and fix. */
function entry(f: Finding): string {
  if (f.kind === 'real' && f.fix === null) return `  - ${f.span}`
  return `  - span: ${f.span}\n    kind: ${f.kind}\n    fix: ${JSON.stringify(f.fix)}`
}
