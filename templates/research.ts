import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { Provider } from '../providers/kind.ts'
import { loadReviews, specHash } from '../reviews/bench.ts'
import { read } from '../reviews/verdict.ts'
import { benchPacket, spec } from '../runner/packet.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { prose } from '../sequencer/prose.ts'
import { WIRE, type Wire } from '../sequencer/push.ts'
import { ran } from '../sequencer/seat.ts'
import { get, maybe, planDir, put, srcDir, titleOf } from '../sequencer/workspace.ts'
import { runLogged } from '../store/events.ts'
import { proofed } from '../store/desk.ts'
import type { Db } from '../store/index.ts'
import { get as setting, observed, wall } from '../store/lanes.ts'
import { originRef, type PlanRow } from '../store/plans.ts'
import { byRun, pending } from '../store/transcript.ts'
import { DEFAULT_BUILDER, type Step } from './pr-path.ts'

const FENCE = /(?:^|\n)---\n(sources:.*\n(?:[ \t-].*\n)*)---\s*$/

const Sources = z.object({
  sources: z.array(z.object({
    url: z.string().trim().min(1),
    fetched_at: z.string(),
    quote: z.string().nullish(),
    claim: z.string(),
  })),
})

export function sourced(root: string, plan: PlanRow, reply: string): Outcome {
  const fence = FENCE.exec(reply)
  const got = Sources.safeParse(fence === null ? null : prose(fence[1] ?? '', ['fetched_at', 'quote', 'claim']))
  if (!got.success) return { outcome: 'refuse', spans: ['researcher.fence'], note: 'researcher reply has no valid sources fence' }
  const unquoted = got.data.sources.filter((s) => (s.quote ?? '').trim() === '').map((s) => s.url)
  if (unquoted.length > 0) return { outcome: 'refuse', spans: ['researcher.unquoted'], note: `no quote for ${unquoted.join(', ')}` }
  put(root, plan.id, 'sources.json', JSON.stringify(got.data.sources))
  return { outcome: 'pass', spans: [], note: `sources.json written with ${String(got.data.sources.length)} source(s)` }
}

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()

const page = (url: string): Promise<{ ok: boolean; text: string }> => fetch(url).then(
  async (res) => res.ok ? { ok: true, text: flat(await res.text()) } : { ok: false, text: String(res.status) },
  (error: unknown) => ({ ok: false, text: error instanceof Error ? error.message : String(error) }))

export async function check(root: string, plan: PlanRow): Promise<Outcome> {
  const sources = JSON.parse(get(root, plan.id, 'sources.json')) as { url: string; quote: string }[]
  if (sources.length === 0) return { outcome: 'pass', spans: [], note: 'no sources: nothing found' }
  const claims = get(root, plan.id, 'answer.md').replace(/\n## Still unknown$[\s\S]*/m, '').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .flatMap((l) => l.split(/(?<=[.!?]|\[source:\d+\])\s+(?!\[source:)/)).map((sentence) => {
      const cited = [...sentence.matchAll(/\[source:(\d+)\]/g)].map((m) => sources[Number(m[1]) - 1])
      return { sentence, cited: cited.length > 0 && cited.every((s) => s !== undefined) ? cited : null }
    })
  const unsourced = claims.filter((c) => c.cited === null).map((c) => `"${c.sentence}"`)
  if (unsourced.length > 0) return { outcome: 'refuse', spans: ['research.unsourced'], note: `no source for ${unsourced.join(', ')}` }
  const cites = claims.flatMap((c) => (c.cited ?? []).map((s) => ({ claim: c.sentence, url: s.url, quote: flat(s.quote) })))
  const pages = new Map(await Promise.all([...new Set(cites.map((c) => c.url))].map(async (url) => [url, await page(url)] as const)))
  const dead = [...pages].filter(([, p]) => !p.ok).map(([url, p]) => `${url} (${p.text})`)
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

export function question(root: string, plan: PlanRow): Outcome {
  const lines = (maybe(root, plan.id, 'ask.md') ?? maybe(root, plan.id, 'issue.md') ?? '').split('\n')
  const said = LINES.map(([key, label]) => [key, label, lines.find((l) => l.startsWith(label))?.slice(label.length).trim() ?? ''] as const)
  const missing = said.filter(([, , rest]) => rest === '').map(([, label]) => label)
  if (missing.length > 0) return { outcome: 'refuse', spans: ['ask.md'], note: `ask.md has no ${missing.join(' or ')} line` }
  put(root, plan.id, 'question.json', JSON.stringify(Object.fromEntries(said.map(([key, , rest]) => [key, rest]))))
  return { outcome: 'pass', spans: [], note: 'question.json written' }
}

export async function gather(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  const fired = await ran(db, root, plan, step, provider, `# question.json\n\n${get(root, plan.id, 'question.json')}`, false)
  if (fired.ended !== 'completed') return { outcome: 'refuse', spans: [fired.stop_reason ?? 'seat.exit'], note: `${step.runs} ${fired.ended}` }
  const sources = sourced(root, plan, fired.text)
  if (sources.outcome === 'refuse') return sources
  put(root, plan.id, 'answer.md', fired.text.replace(FENCE, '').trim())
  return { outcome: 'pass', spans: [], note: `${step.runs}: answer.md written, ${sources.note}` }
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
  const sources = JSON.parse(get(root, plan.id, 'sources.json')) as { url: string; fetched_at: string; quote: string; claim: string }[]
  const part = (from: number, to?: number): string => lines.slice(from, to).join('\n').trim()
  const answer = part(0, wrong)
  const added = db.transaction(() => {
    if (!proofed(db, { id: plan.id, kind: 'note', dest: 'site', title, dek: asked.question, body: answer.split(/\s+/).slice(0, 150).join(' '),
      sources: JSON.stringify(sources.map((s) => ({ claim: s.claim, ref: s.url }))), checks: '[]', work_date: day, written_date: day })) return false
    mkdirSync(join(dir, 'findings'), { recursive: true })
    writeFileSync(path, `${[`# ${title}`, '## Question', asked.question, '## Answer', answer, WRONG, asked.wrong_if, part(wrong + 1, unknown), '## Sources',
      sources.map((s, i) => `${String(i + 1)}. ${s.url} (${s.fetched_at}): "${s.quote}"`).join('\n'), UNKNOWN, part(unknown + 1)].join('\n\n')}\n`)
    return true
  })()
  if (!added) return { outcome: 'pass', spans: [], note: 'already recorded' }
  const ref = originRef(plan)
  if (ref !== null) wire.close(ref.repo, ref.no, '', `Finding: ${path}`)
  return { outcome: 'pass', spans: [], note: `finding at ${path}` }
}
