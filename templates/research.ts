import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { Provider } from '../providers/kind.ts'
import { loadReviews, specHash } from '../reviews/bench.ts'
import { read } from '../reviews/verdict.ts'
import { benchPacket, spec } from '../runner/packet.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { prose } from '../sequencer/prose.ts'
import { WIRE, type Wire } from '../sequencer/push.ts'
import { ran } from '../sequencer/seat.ts'
import { get, headSha, maybe, planDir, put, srcDir, titleOf } from '../sequencer/workspace.ts'
import { runLogged } from '../store/events.ts'
import { proofed } from '../store/desk.ts'
import type { Db } from '../store/index.ts'
import { get as setting, observed, wall } from '../store/lanes.ts'
import { originRef, type PlanRow } from '../store/plans.ts'
import { refusalRows } from '../store/refusals.ts'
import { transcripts } from '../store/runs.ts'
import { byRun, outputs, pending } from '../store/transcript.ts'
import { DEFAULT_BUILDER, type Step } from './pr-path.ts'
import { verified, type Ran } from './verified.ts'

export const FENCE = /(?:^|\n)(?:```\w*\n)?---[ \t]*\n(sources:[\s\S]*?)\n---[ \t]*(?:\n```[ \t]*)?\s*$/

const NEEDS = /(?:^|\n)(?:```\w*\n)?---[ \t]*\noutcome:[ \t]*(needs_run|needs_build)[ \t]*\n---[ \t]*(?:\n```[ \t]*)?\s*$/

const MOVING = /^https?:\/\/(?:github\.com\/[^/]+\/[^/]+\/(?:blob|commits)|raw\.githubusercontent\.com\/[^/]+\/[^/]+|api\.github\.com\/repos\/[^/]+\/[^/]+\/(?:commits|git\/trees))\/(?:main|master|HEAD)(?:[/?#]|$)/

const KEYS = ['fetched_at', 'quote', 'claim', 'command', 'commit']

const Url = z.object({
  url: z.string().trim().min(1),
  fetched_at: z.string(),
  quote: z.string().nullish(),
  claim: z.string(),
})

const Run = z.object({
  run: z.object({ command: z.string().trim().min(1), commit: z.string().trim().min(1), quote: z.string().nullish(), claim: z.string() }),
})

/** Picked by its `run:` key: a union would name a broken entry `Invalid input` instead of the field it lacks. */
const Entry = z.unknown().transform((entry, ctx) => {
  const got = (typeof entry === 'object' && entry !== null && 'run' in entry ? Run : Url).safeParse(entry)
  for (const issue of got.error?.issues ?? []) ctx.addIssue({ ...issue })
  return got.data ?? z.NEVER
})

const Sources = z.object({ sources: z.array(Entry) })

export type Source = { url: string; fetched_at: string; quote: string; claim: string } | { run: { command: string; commit: string; quote: string; claim: string } }

const plain = (s: Source): { quote: string; claim: string } => 'run' in s ? s.run : s

const named = (s: Source): string => 'run' in s ? `\`${s.run.command}\` at ${s.run.commit}` : s.url

function fenced(reply: string): { data: z.infer<typeof Sources> } | { why: string } {
  const body = FENCE.exec(reply)?.[1]
  if (body === undefined) return { why: 'the reply does not close with `---`, `sources:`, its entries, `---`' }
  const parsed = prose(body, KEYS)
  if (parsed === null) {
    const lines = body.split('\n')
    const i = lines.findIndex((line, n) => prose([...lines.slice(0, n), line].join('\n'), KEYS) === null)
    return { why: `line ${String(i + 1)}: ${lines[i] ?? ''}` }
  }
  const got = Sources.safeParse(parsed)
  return got.success ? { data: got.data } : { why: got.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') }
}

function vetted(reply: string): Outcome | { sources: Source[] } {
  const got = fenced(reply)
  if ('why' in got) return { outcome: 'refuse', spans: ['researcher.fence'], note: `researcher reply has no valid sources fence: ${got.why}` }
  const unquoted = got.data.sources.filter((s) => (('run' in s ? s.run.quote : s.quote) ?? '').trim() === '').map((s) => 'run' in s ? s.run.command : s.url)
  if (unquoted.length > 0) return { outcome: 'refuse', spans: ['researcher.unquoted'], note: `no quote for ${unquoted.join(', ')}` }
  const moving = got.data.sources.flatMap((s) => 'url' in s && MOVING.test(s.url) ? [s.url] : [])
  if (moving.length > 0) return { outcome: 'refuse', spans: ['research.moving_ref'], note: `moving ref in ${moving.join(', ')}` }
  return { sources: got.data.sources as Source[] }
}

export function sourced(root: string, plan: PlanRow, reply: string): Outcome {
  const got = vetted(reply)
  if ('outcome' in got) return got
  put(root, plan.id, 'sources.json', JSON.stringify(got.sources))
  return { outcome: 'pass', spans: [], note: `sources.json written with ${String(got.sources.length)} source(s)` }
}

function against(root: string, plan: PlanRow, answer: string, sources: Source[], stated?: (answer: string) => void): Promise<Outcome> {
  return verified(askOf(root, plan), answer, sources, JSON.parse(maybe(root, plan.id, 'runs.json') ?? '[]') as Ran[], () => headSha(srcDir(root, plan.id)), stated)
}

export function check(db: Db, root: string, plan: PlanRow): Promise<Outcome> {
  const again = refusalRows(db, plan.id)[0]?.span === 'research.quote_missing'
  return against(root, plan, get(root, plan.id, 'answer.md'), JSON.parse(get(root, plan.id, 'sources.json')) as Source[],
    again ? (text) => put(root, plan.id, 'answer.md', text) : undefined)
}


export function drafted(root: string, plan: PlanRow, reply: string): Promise<Outcome> {
  const got = vetted(reply)
  return 'outcome' in got ? Promise.resolve(got) : against(root, plan, reply.replace(FENCE, '').trim(), got.sources)
}

const row = (name: string, step: number): Step =>
  ({ step, name, seat: DEFAULT_BUILDER, fires: 'kernel', runs: name, gate: false, writes_verdict: false, verdict_gate: null })

export const steps: Step[] = ['question', 'gather', 'check', 'review', 'record'].map((name, i) =>
  name === 'gather' ? { ...row(name, i), seat: 'researcher', fires: 'seat', runs: 'researcher' }
  : name === 'review' ? { ...row(name, i), fires: 'seat', runs: 'senior_review' } : row(name, i))

const LINES = [['question', '**Question:**', '**What:**'], ['wrong_if', '**Would be wrong if:**', null], ['done_when', '**Done when:**', '**When it ends:**']] as const

const PART_WRONG = 'it leaves out what this part asks, or answers what its parent ticket asks'

const WRITTEN = 'question.json written'

const askOf = (root: string, plan: PlanRow): string =>
  ['ask.md', 'issue.md'].flatMap((name) => maybe(root, plan.id, name) ?? []).join('\n')

const said = (ask: string) => {
  const lines = ask.split('\n')
  const parent = lines.findIndex((l) => l === '## Parent ticket' || l === '## Parent comments')
  const own = parent === -1 ? lines : lines.slice(0, parent)
  const line = (label: string): string => own.find((l) => l.startsWith(label))?.slice(label.length).trim() ?? ''
  return LINES.map(([key, label, field]) => {
    const from = line(label) !== '' || parent === -1 ? null : field ?? 'the fixed part sentence'
    return [key, label, from === null ? line(label) : field === null ? PART_WRONG : line(field), from] as const
  })
}

export const unasked = (ask: string): string[] => said(ask).filter(([, , rest]) => rest === '').map(([, label]) => label)

export function question(root: string, plan: PlanRow): Outcome {
  const ask = askOf(root, plan)
  const missing = unasked(ask)
  if (missing.length > 0) return { outcome: 'refuse', spans: ['ask.md'], note: `ask.md has no ${missing.join(' or ')} line` }
  put(root, plan.id, 'question.json', JSON.stringify(Object.fromEntries(said(ask).map(([key, , rest]) => [key, rest]))))
  const filled = said(ask).flatMap(([, label, , from]) => from === null ? [] : [`${label} from ${from}`])
  return { outcome: 'pass', spans: [], note: `${WRITTEN}${filled.length === 0 ? '' : `, filled for a part: ${filled.join(', ')}`}` }
}

const OUTPUT = '**Output:**'

/** `named` made absolute when it is a folder strictly under ~/cf_work/. */
export function work(named: string): string | null {
  const out = resolve(named.startsWith('~/') ? join(homedir(), named.slice(2)) : named)
  const rel = relative(join(homedir(), 'cf_work'), out)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? null : out
}

/** The ask's `**Output:**` folder made absolute, or why it is refused. */
function output(ask: string): { out?: string } | { why: string } {
  const named = ask.split('\n').find((l) => l.startsWith(OUTPUT))?.slice(OUTPUT.length).trim()
  if (named === undefined) return {}
  const out = work(named)
  return out === null ? { why: `${OUTPUT} ${named} is not a folder under ~/cf_work/` } : { out }
}

const BEFORE = '\n\n# Before you hand in\n\nWrite the answer and its closing fence to `.cf/draft.md`, run `cf research check .cf/draft.md`, fix what it names, '
  + 'and hand in that draft only once it prints `pass`.'

export async function gather(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  const asked = question(root, plan)
  if (asked.outcome === 'refuse') return asked
  const got = await gathering(db, root, plan, step, provider)
  return asked.note === WRITTEN ? got : { ...got, note: `${asked.note}; ${got.note}` }
}

async function gathering(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  const ask = askOf(root, plan)
  const folder = output(ask)
  if ('why' in folder) return { outcome: 'refuse', spans: ['ask.md'], note: folder.why }
  const { out } = folder
  const measure = out !== undefined || ask.split('\n').some((l) => l.startsWith('**Measure:**'))
  const runs = out !== undefined ? 'fetcher' : measure ? 'measurer' : null
  const seat = runs === null ? step : { ...step, seat: runs, runs }
  if (out !== undefined) mkdirSync(out, { recursive: true })
  const last = maybe(root, plan.id, 'answer.md')
  const input = `# Ask\n\n${askOf(root, plan)}\n\n# question.json\n\n${get(root, plan.id, 'question.json')}${
    maybe(root, plan.id, 'refusal.md')?.replace(/^/, '\n\n# Refused — fix what this names\n\n') ?? ''}${last === null ? '' : `\n\n# Your last answer — repair what the ask and the refusal name, keep the rest\n\n${
    last}\n\n# Its sources, [source:n] counting from 1\n\n${get(root, plan.id, 'sources.json')}`}${measure ? `\n\n# HEAD\n\n${headSha(srcDir(root, plan.id))}` : ''}${
    out === undefined ? '' : `\n\n# Output\n\n${out}`}${runs === null ? BEFORE : ''}`
  const fires: Provider = runs === null ? { ...provider, fire: (packet) => provider.fire({ ...packet, idle: Number.POSITIVE_INFINITY }) } : provider
  const draft = join(srcDir(root, plan.id), '.cf/draft.md')
  rmSync(draft, { force: true })
  const fired = await ran(db, root, plan, seat, fires, input, false, true, out)
  if (fired.ended !== 'completed') return { outcome: 'refuse', spans: [fired.stop_reason ?? 'seat.exit'], note: `${seat.runs} ${fired.ended}` }
  const needs = NEEDS.exec(fired.text)?.[1]
  if (!measure && needs === 'needs_run') {
    return { outcome: 'refuse', spans: ['ask.md'], note: 'ask needs executed runs: add a **Measure:** line so the measurer gathers it' }
  }
  if (measure && needs === 'needs_build') {
    const note = 'ask needs network or writes outside .cf/measure/: add an **Output:** line naming a folder under ~/cf_work/ so the fetcher runs it'
    put(root, plan.id, 'question.md', note)
    return { outcome: 'needs_ceo', spans: ['ask.md'], note }
  }
  const fromDraft = !FENCE.test(fired.text) && existsSync(draft)
  const reply = fromDraft ? readFileSync(draft, 'utf8') : fired.text
  const sources = sourced(root, plan, reply)
  if (sources.outcome === 'refuse') return sources
  if (measure) put(root, plan.id, 'runs.json', JSON.stringify(transcripts(db, plan.id, step.step).flatMap(outputs)))
  put(root, plan.id, 'answer.md', reply.replace(FENCE, '').trim())
  return { outcome: 'pass', spans: [], note: `${seat.runs}: answer.md written${fromDraft ? ' from .cf/draft.md, the reply had no fence' : ''}, ${sources.note}` }
}

export async function answered(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  loadReviews(db, root)
  const answer = get(root, plan.id, 'answer.md')
  const input = { repo: srcDir(root, plan.id), issue: get(root, plan.id, 'question.json'),
    diff: `# answer.md\n\n${answer}\n\n# sources.json\n\n${get(root, plan.id, 'sources.json')}`, verdict: 'none: a research plan has no first reader' }
  const lead = `${spec(root, step.runs)}\n${readFileSync(join(root, 'seats/modes/research.md'), 'utf8')}`
  const built = benchPacket(root, step.runs, input, pending(planDir(root, plan.id), `step-${String(step.step)}`), lead)
  if ('refusal' in built) return { outcome: 'refuse', spans: [built.refusal.path], note: `${step.runs} packet refused on ${built.refusal.path}` }
  const fired = await provider.fire({ ...built.packet, wall: wall(db) })
  const run = runLogged(db, { plan: plan.id, step: step.step, seat: step.runs, rule_hash: specHash(root, step.runs), provider: provider.name,
    model: built.packet.model, effort: built.packet.effort, exit: fired.exit, fired })
  byRun(db, run, fired.transcript_path)
  observed(db, fired.limits)
  if (fired.ended !== 'completed') return { outcome: 'refuse', spans: [fired.stop_reason ?? 'seat.exit'], note: `${step.runs} ${fired.ended}` }
  const judged = read(fired.text, answer)
  if (judged === null) return { outcome: 'refuse', spans: ['senior_review.fence'], note: `${step.runs} reply has no valid verdict fence` }
  if (judged.outcome === 'refuse') return { outcome: 'refuse', spans: judged.spans, note: judged.message, to: 1 }
  if (judged.outcome === 'needs_ceo') return { outcome: 'needs_ceo', spans: [], note: judged.message }
  put(root, plan.id, 'review.md', judged.message)
  return { outcome: 'pass', spans: [], note: `${step.runs}: review.md written` }
}

const [WRONG, UNKNOWN] = ['## Would be wrong if', '## Still unknown']

export function record(db: Db, root: string, plan: PlanRow, wire: Wire = WIRE): Outcome {
  const lines = get(root, plan.id, 'answer.md').split('\n')
  const wrong = lines.indexOf(WRONG)
  const unknown = lines.indexOf(UNKNOWN, wrong)
  if (wrong === -1 || unknown === -1) return { outcome: 'refuse', spans: ['answer.md'], note: `answer.md has no ${wrong === -1 ? WRONG : UNKNOWN} section` }
  const value = setting(db, 'science.dir')
  const dir = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  if (dir === '' || !existsSync(dir)) return { outcome: 'refuse', spans: ['science.dir'], note: dir === '' ? 'science.dir is unset' : `science.dir ${dir} does not exist` }
  const title = titleOf(root, plan.id)
  if (title === null) return { outcome: 'refuse', spans: ['ask.md'], note: 'ask.md has no # title' }
  const day = new Date().toISOString().slice(0, 10)
  const path = join(dir, 'findings', `${day}_${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.md`)
  const asked = JSON.parse(get(root, plan.id, 'question.json')) as { question: string; wrong_if: string }
  const sources = JSON.parse(get(root, plan.id, 'sources.json')) as Source[]
  const part = (from: number, to?: number): string => lines.slice(from, to).join('\n').trim()
  const answer = part(0, wrong)
  const added = db.transaction(() => {
    if (!proofed(db, { id: plan.id, kind: 'note', dest: 'site', title, dek: asked.question, body: answer.split(/\s+/).slice(0, 150).join(' '),
      sources: JSON.stringify(sources.map((s) => ({ claim: plain(s).claim, ref: named(s) }))), checks: '[]', work_date: day, written_date: day })) return false
    mkdirSync(join(dir, 'findings'), { recursive: true })
    writeFileSync(path, `${[`# ${title}`, '## Question', asked.question, '## Answer', answer, WRONG, asked.wrong_if, part(wrong + 1, unknown), '## Sources',
      sources.map((s, i) => `${String(i + 1)}. ${'run' in s ? named(s) :`${s.url} (${s.fetched_at})`}: "${plain(s).quote}"`).join('\n'), UNKNOWN,
      part(unknown + 1)].join('\n\n')}\n`)
    return true
  })()
  if (!added) return { outcome: 'pass', spans: [], note: 'already recorded' }
  const ref = originRef(plan)
  if (ref !== null) wire.close(ref.repo, ref.no, '', `Finding: ${path}`)
  return { outcome: 'pass', spans: [], note: `finding at ${path}` }
}
