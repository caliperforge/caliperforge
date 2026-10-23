import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { Provider } from '../providers/kind.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { prose } from '../sequencer/prose.ts'
import { ran } from '../sequencer/seat.ts'
import { get, maybe, put } from '../sequencer/workspace.ts'
import { ours, readyOn, targeted } from '../store/account.ts'
import type { Db } from '../store/index.ts'
import { zone } from '../store/lanes.ts'
import type { PlanRow } from '../store/plans.ts'
import { addTarget, newestAccount, type Target } from '../store/targets.ts'
import { DEFAULT_BUILDER, type Step } from './pr-path.ts'
import { FENCE, sourced } from './research.ts'

const row = (name: string, step: number): Step =>
  ({ step, name, seat: DEFAULT_BUILDER, fires: 'kernel', runs: name, gate: false, writes_verdict: false, verdict_gate: null })

export const steps: Step[] = ['read', 'brief', 'check', 'ideas', 'log'].map((name, i) =>
  name === 'brief' ? { ...row(name, i), seat: 'account_lead', fires: 'seat', runs: 'account_lead' } : row(name, i))

const [REPOS, LOG] = ['## Repos and channels', '## Log']

const REPO = /^[\w.-]+\/[\w.-]+$/

const DATED = /^- \d{4}-\d{2}-\d{2} /

const Ideas = z.array(z.object({ repo: z.string().regex(REPO), issue: z.int().positive(), why: z.string(), size: z.string() }))

const IDEAS = /(?:^|\n)(?:```\w*\n)?---[ \t]*\n(ideas:[\s\S]*?)\n---[ \t]*(?:\n```[ \t]*)?/

function account(root: string, plan: PlanRow): { path: string; text: string } | Outcome {
  const ask = maybe(root, plan.id, 'ask.md') ?? maybe(root, plan.id, 'issue.md') ?? ''
  const slug = /^\*\*Account:\*\*[ \t]*([\w-]+)[ \t]*$/m.exec(ask)?.[1]
  if (slug === undefined) return { outcome: 'refuse', spans: ['ask.md'], note: 'ask.md has no **Account:** line' }
  const path = join('accounts', `${slug}.md`)
  if (!existsSync(join(root, path))) return { outcome: 'refuse', spans: [path], note: `${path} is missing` }
  return { path, text: readFileSync(join(root, path), 'utf8') }
}

function section(lines: string[], heading: string): { from: number; body: string[] } | null {
  const at = lines.indexOf(heading)
  if (at === -1) return null
  const next = lines.findIndex((l, i) => i > at && l.startsWith('## '))
  return { from: at + 1, body: lines.slice(at + 1, next === -1 ? lines.length : next) }
}

function repos(text: string): string[] {
  return (section(text.split('\n'), REPOS)?.body ?? []).map((l) => l.replace(/^- /, '')).filter((l) => REPO.test(l))
}

export function reading(db: Db, root: string, plan: PlanRow): Outcome {
  const found = account(root, plan)
  if ('outcome' in found) return found
  const names = repos(found.text)
  const rows = names.map((repo) => ours(db, repo))
  const listed = (key: 'plans' | 'prs' | 'targets'): string => rows.flatMap((r) => r[key].map((x) => JSON.stringify(x))).join('\n') || 'none'
  put(root, plan.id, 'reading.md', `${found.text.trimEnd()}\n\n# Our plans\n\n${listed('plans')}\n\n# Our pull requests\n\n${listed('prs')}\n\n# Our targets\n\n${listed('targets')}\n`)
  return { outcome: 'pass', spans: [], note: `reading.md written from ${found.path} and ${String(names.length)} repo(s)` }
}

export async function brief(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  const input = `# Account\n\n${get(root, plan.id, 'reading.md')}${
    maybe(root, plan.id, 'refusal.md')?.replace(/^/, '\n\n# Refused — fix what this names\n\n') ?? ''}`
  const fired = await ran(db, root, plan, step, provider, input, false)
  if (fired.ended !== 'completed') return { outcome: 'refuse', spans: [fired.stop_reason ?? 'seat.exit'], note: `${step.runs} ${fired.ended}` }
  const sources = sourced(db, root, plan, fired.text)
  if (sources.outcome === 'refuse') return sources
  const got = Ideas.safeParse((prose(IDEAS.exec(fired.text)?.[1] ?? '', ['why', 'size']) as { ideas?: unknown } | null)?.ideas)
  if (!got.success) {
    return { outcome: 'refuse', spans: ['account_lead.ideas'],
      note: `${step.runs} reply has no valid ideas fence: ${got.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` }
  }
  const body = (sources.reply ?? fired.text).replace(IDEAS, '').replace(FENCE, '').trim()
  const draft = section(body.split('\n'), '## Draft')
  if (draft !== null && !draft.body.some((l) => /\[source:\d+\]/.test(l))) {
    return { outcome: 'refuse', spans: ['account_lead.draft'], note: '## Draft cites no source: a check-in with no result' }
  }
  put(root, plan.id, 'ideas.json', JSON.stringify(got.data))
  put(root, plan.id, 'answer.md', body)
  return { outcome: 'pass', spans: [], note: `${step.runs}: answer.md written, ${sources.note}` }
}

export function ideas(db: Db, root: string, plan: PlanRow): Outcome {
  const got = Ideas.safeParse(JSON.parse(get(root, plan.id, 'ideas.json')))
  if (!got.success) return { outcome: 'refuse', spans: ['ideas.json'], note: got.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') }
  const day = new Date().toISOString().slice(0, 10)
  const stored = got.data.filter((i) => targeted(db, i.repo, i.issue)).length
  const fresh = got.data.filter((i, n) => !targeted(db, i.repo, i.issue) && got.data.findIndex((j) => j.repo === i.repo && j.issue === i.issue) === n)
  const rows = fresh.flatMap((i): Target[] => {
    const known = newestAccount(db, i.repo) as { id: number } | undefined
    return known === undefined ? [] : [{ account_id: known.id, repo: i.repo, issue_no: i.issue, named_merger: '', state: 'ready',
      evidence_measured_at: day, evidence: `https://github.com/${i.repo}/issues/${String(i.issue)}` }]
  })
  const unknown = [...new Set(fresh.filter((i) => !rows.some((r) => r.repo === i.repo)).map((i) => i.repo))]
  if (unknown.length > 0) return { outcome: 'refuse', spans: ['accounts'], note: `no accounts row for ${unknown.join(', ')}` }
  db.transaction(() => { for (const r of rows) addTarget(db, r) })()
  return { outcome: 'pass', spans: [], note: `${String(rows.length)} target(s) written ready, ${String(stored)} already in targets, ${String(got.data.length - stored - rows.length)} repeated` }
}

export function log(db: Db, root: string, plan: PlanRow): Outcome {
  const found = account(root, plan)
  if ('outcome' in found) return found
  const dir = join('accounts', 'briefs', basename(found.path, '.md'))
  const written = join(dir, `${new Date(Date.now() + zone(db) * 60000).toISOString().slice(0, 10)}.md`)
  mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, written), `**Ready targets:** ${String(readyOn(db, repos(found.text)))}\n\n${get(root, plan.id, 'answer.md')}\n`)
  const lines = found.text.split('\n')
  const at = section(lines, LOG)
  if (at === null) return { outcome: 'refuse', spans: [found.path], note: `${found.path} has no ${LOG} section` }
  const rows = [...new Set(get(root, plan.id, 'answer.md').split('\n').filter((l) => DATED.test(l) && !at.body.includes(l)))]
  if (rows.length === 0) return { outcome: 'pass', spans: [], note: `${written} written; no new ${LOG} rows` }
  lines.splice(at.from + at.body.findLastIndex((l) => l.trim() !== '') + 1, 0, ...rows)
  writeFileSync(join(root, found.path), lines.join('\n'))
  return { outcome: 'pass', spans: [], note: `${written} written; ${String(rows.length)} row(s) added to ${found.path} ${LOG}` }
}
