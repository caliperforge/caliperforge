import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Provider } from '../providers/kind.ts'
import { loadReviews, specHash } from '../reviews/bench.ts'
import { read } from '../reviews/verdict.ts'
import { benchPacket, spec } from '../runner/packet.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { prose } from '../sequencer/prose.ts'
import { ran } from '../sequencer/seat.ts'
import { get, maybe, planDir, put, srcDir } from '../sequencer/workspace.ts'
import { runLogged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { observed, wall } from '../store/lanes.ts'
import type { PlanRow } from '../store/plans.ts'
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
  const claims = get(root, plan.id, 'answer.md').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))
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
