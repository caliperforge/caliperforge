import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
import { lastTranscript } from '../store/runs.ts'
import { byRun, outputs, pending } from '../store/transcript.ts'
import { DEFAULT_BUILDER, type Step } from './pr-path.ts'

export const FENCE = /(?:^|\n)(?:```\w*\n)?---[ \t]*\n(sources:[\s\S]*?)\n---[ \t]*(?:\n```[ \t]*)?\s*$/

const NEEDS = /(?:^|\n)(?:```\w*\n)?---[ \t]*\noutcome:[ \t]*(needs_run|needs_build)[ \t]*\n---[ \t]*(?:\n```[ \t]*)?\s*$/

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

type Source = { url: string; fetched_at: string; quote: string; claim: string } | { run: { command: string; commit: string; quote: string; claim: string } }

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

export function sourced(root: string, plan: PlanRow, reply: string): Outcome {
  const got = fenced(reply)
  if ('why' in got) return { outcome: 'refuse', spans: ['researcher.fence'], note: `researcher reply has no valid sources fence: ${got.why}` }
  const unquoted = got.data.sources.filter((s) => (('run' in s ? s.run.quote : s.quote) ?? '').trim() === '').map((s) => 'run' in s ? s.run.command : s.url)
  if (unquoted.length > 0) return { outcome: 'refuse', spans: ['researcher.unquoted'], note: `no quote for ${unquoted.join(', ')}` }
  put(root, plan.id, 'sources.json', JSON.stringify(got.data.sources))
  return { outcome: 'pass', spans: [], note: `sources.json written with ${String(got.data.sources.length)} source(s)` }
}

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()

const RULER = /^(?=.*\|)(?=.*-)[ |:-]+$/

const ROW = /^\s*\|/

const LINK = /https?:\/\/[^\s|)\]>]+/g

const SKIPPED = /^(#{1,6})[ \t]+(?:Method|Not found|Still unknown|How I applied it):?[ \t]*$[\s\S]*?(?=^(?!\1#)#{1,6}[ \t]|(?![\s\S]))/gim

const bare = (s: string): string => flat(s.replace(/[*_`"“”>]/g, ''))

const cited = (claim: string, sources: Source[]): Source[] | null => {
  const links: string[] = ROW.test(claim) ? claim.match(LINK) ?? [] : []
  const all = [...[...claim.matchAll(/\[source:(\d+)\]/g)].map((m) => sources[Number(m[1]) - 1]), ...sources.filter((s) => 'url' in s && links.includes(s.url))]
  return all.length > 0 && all.every((s) => s !== undefined) ? all : null
}

type Page = { ok: true; text: string } | { ok: false; text: string; span: 'research.dead_source' | 'research.pdf_unread' }

const ENTITY: Record<string, string> = { '&amp;': '&', '&#39;': "'", '&quot;': '"', '&nbsp;': ' ' }

function pdf(bytes: ArrayBuffer): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'research-'))
  try {
    const file = join(dir, 'page.pdf')
    writeFileSync(file, Buffer.from(bytes))
    const got = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
    return got.status === 0 ? got.stdout : null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function seen(url: string, res: Response): Promise<string | null> {
  const type = res.headers.get('content-type') ?? ''
  const { pathname, hostname } = new URL(url)
  if (type.includes('application/pdf') || pathname.endsWith('.pdf')) return pdf(await res.arrayBuffer())
  const text = await res.text()
  if (type.includes('text/html')) {
    return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&(?:amp|#39|quot|nbsp);/g, (e) => ENTITY[e] ?? e)
  }
  return pathname.endsWith('.md') || hostname === 'raw.githubusercontent.com' ? text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') : text
}

const page = (url: string): Promise<Page> => fetch(url).then(
  async (res): Promise<Page> => {
    if (!res.ok) return { ok: false, text: String(res.status), span: 'research.dead_source' }
    const text = await seen(url, res)
    return text === null ? { ok: false, text: url, span: 'research.pdf_unread' } : { ok: true, text: flat(text) }
  },
  (error: unknown): Page => ({ ok: false, text: error instanceof Error ? error.message : String(error), span: 'research.dead_source' }))

function unmeasured(root: string, plan: PlanRow, runs: { claim: string; command: string; commit: string; quote: string }[]): Outcome | null {
  if (runs.length === 0) return null
  const head = headSha(srcDir(root, plan.id))
  const stale = runs.filter((r) => r.commit !== head).map((r) => `"${r.claim}" (${r.command})`)
  if (stale.length > 0) return { outcome: 'refuse', spans: ['research.run_commit'], note: `run not at HEAD ${head} for ${stale.join(', ')}` }
  const given = JSON.parse(maybe(root, plan.id, 'runs.json') ?? '[]') as { command: string; output: string }[]
  const missing = runs.filter((r) => !given.some((g) => g.command === r.command && flat(g.output).includes(flat(r.quote))))
    .map((r) => `"${r.claim}" (${r.command})`)
  return missing.length > 0 ? { outcome: 'refuse', spans: ['research.run_missing'], note: `quote not in the run's output for ${missing.join(', ')}` } : null
}

export async function check(root: string, plan: PlanRow): Promise<Outcome> {
  const sources = JSON.parse(get(root, plan.id, 'sources.json')) as Source[]
  if (sources.length === 0) return { outcome: 'pass', spans: [], note: 'no sources: nothing found' }
  const ask = bare(askOf(root, plan))
  const lines = get(root, plan.id, 'answer.md').replace(SKIPPED, '').split('\n')
  const claims = lines.filter((l, i) => l.trim() !== '' && !l.startsWith('#') && !RULER.test(l) && !RULER.test(lines[i + 1] ?? ''))
    .flatMap((l) => ROW.test(l) ? [l] : l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').split(/(?<=^(?:[^`]*`[^`]*`)*[^`]*(?:[.!?]|\[source:\d+\]))\s+(?!\[source:)/))
    .filter((sentence) => !ask.includes(bare(sentence)) && !/:(?:\*\*)?\s*$/.test(sentence))
    .map((sentence) => ({ sentence, cited: cited(sentence, sources) }))
  const unsourced = claims.filter((c) => c.cited === null).map((c) => `"${c.sentence}"`)
  if (unsourced.length > 0) return { outcome: 'refuse', spans: ['research.unsourced'], note: `no source for ${unsourced.join(', ')}` }
  const measured = unmeasured(root, plan, claims.flatMap((c) => (c.cited ?? []).flatMap((s) => 'run' in s ? [{ ...s.run, claim: c.sentence }] : [])))
  if (measured !== null) return measured
  const cites = claims.flatMap((c) => (c.cited ?? []).flatMap((s) => 'url' in s ? [{ claim: c.sentence, url: s.url, quote: flat(s.quote) }] : []))
  const pages = new Map(await Promise.all([...new Set(cites.map((c) => c.url))].map(async (url) => [url, await page(url)] as const)))
  const unread = [...pages].filter(([, p]) => !p.ok && p.span === 'research.pdf_unread').map(([url]) => url)
  if (unread.length > 0) return { outcome: 'refuse', spans: ['research.pdf_unread'], note: `pdftotext could not read ${unread.join(', ')}` }
  const dead = [...pages].filter(([, p]) => !p.ok && p.span === 'research.dead_source').map(([url, p]) => `${url} (${p.text})`)
  if (dead.length > 0) return { outcome: 'refuse', spans: ['research.dead_source'], note: `dead source: ${dead.join(', ')}` }
  const missing = cites.filter((c) => pages.get(c.url)?.text.includes(c.quote) !== true).map((c) => `"${c.claim}" (${c.url})`)
  if (missing.length > 0) return { outcome: 'refuse', spans: ['research.quote_missing'], note: `quote not on the page for ${missing.join(', ')}` }
  return { outcome: 'pass', spans: [], note: `${String(claims.length)} sentence(s) checked against ${String(pages.size)} url(s)` }
}

const row = (name: string, step: number): Step =>
  ({ step, name, seat: DEFAULT_BUILDER, fires: 'kernel', runs: name, gate: false, writes_verdict: false, verdict_gate: null })

export const steps: Step[] = ['question', 'gather', 'check', 'review', 'record'].map((name, i) =>
  name === 'gather' ? { ...row(name, i), seat: 'researcher', fires: 'seat', runs: 'researcher' }
  : name === 'review' ? { ...row(name, i), fires: 'seat', runs: 'senior_review' } : row(name, i))

const LINES = [['question', '**Question:**'], ['wrong_if', '**Would be wrong if:**'], ['done_when', '**Done when:**']] as const

const askOf = (root: string, plan: PlanRow): string => maybe(root, plan.id, 'ask.md') ?? maybe(root, plan.id, 'issue.md') ?? ''

const said = (ask: string) => {
  const lines = ask.split('\n')
  return LINES.map(([key, label]) => [key, label, lines.find((l) => l.startsWith(label))?.slice(label.length).trim() ?? ''] as const)
}

export const unasked = (ask: string): string[] => said(ask).filter(([, , rest]) => rest === '').map(([, label]) => label)

export function question(root: string, plan: PlanRow): Outcome {
  const ask = askOf(root, plan)
  const missing = unasked(ask)
  if (missing.length > 0) return { outcome: 'refuse', spans: ['ask.md'], note: `ask.md has no ${missing.join(' or ')} line` }
  put(root, plan.id, 'question.json', JSON.stringify(Object.fromEntries(said(ask).map(([key, , rest]) => [key, rest]))))
  return { outcome: 'pass', spans: [], note: 'question.json written' }
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

export async function gather(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  const ask = askOf(root, plan)
  const folder = output(ask)
  if ('why' in folder) return { outcome: 'refuse', spans: ['ask.md'], note: folder.why }
  const { out } = folder
  const measure = out !== undefined || ask.split('\n').some((l) => l.startsWith('**Measure:**'))
  const runs = out !== undefined ? 'fetcher' : measure ? 'measurer' : null
  const seat = runs === null ? step : { ...step, seat: runs, runs }
  if (out !== undefined) mkdirSync(out, { recursive: true })
  const input = `# Ask\n\n${askOf(root, plan)}\n\n# question.json\n\n${get(root, plan.id, 'question.json')}${
    maybe(root, plan.id, 'refusal.md')?.replace(/^/, '\n\n# Refused — fix what this names\n\n') ?? ''}${measure ? `\n\n# HEAD\n\n${headSha(srcDir(root, plan.id))}` : ''}${
    out === undefined ? '' : `\n\n# Output\n\n${out}`}`
  const fired = await ran(db, root, plan, seat, provider, input, false, true, out)
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
  const sources = sourced(root, plan, fired.text)
  if (sources.outcome === 'refuse') return sources
  if (measure) put(root, plan.id, 'runs.json', JSON.stringify(outputs(lastTranscript(db, plan.id, step.step))))
  put(root, plan.id, 'answer.md', fired.text.replace(FENCE, '').trim())
  return { outcome: 'pass', spans: [], note: `${seat.runs}: answer.md written, ${sources.note}` }
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
