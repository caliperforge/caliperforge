import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { gh, type Issue, type Read } from '../cli/gh.ts'
import { paced } from '../cli/queue.ts'
import type { Board } from '../rails/ci-green/index.ts'
import { parse, type FileDiff } from '../rails/diff.ts'
import { TEST_FILE } from '../rails/test-weakened/index.ts'
import { conventionsOf } from '../rails/test-weakened/languages.ts'
import { unsigned } from '../sequencer/conventions.ts'
import { listed, settled } from '../sequencer/unruled.ts'
import { OPERATOR, srcDir } from '../sequencer/workspace.ts'
import { lastChecks } from './checks.ts'
import type { Db } from './index.ts'
import { lastReview } from './merges.ts'
import { profile, type Profile } from './profile.ts'
import { builds } from './refusals.ts'
import { graded } from './signals.ts'

export interface Fact { name: string; ok: boolean; says: string }

interface Counted { kind: 'code' | 'tests' | 'comments'; ext: string; side: 'added' | 'removed' }

const REASONS: [string, RegExp][] = [
  ['signing', /\b(?:sign|signed|signatures?|dco|gpg|verified)\b/i],
  ['rehearsal PR body', /\b(?:pr|pull request|title|body|template|semantic|hygiene|labels?)\b/i],
  ['secrets', /\b(?:deploy|publish|release|preview|codecov|secrets?|token)\b/i],
]

const PASSED: Record<string, string> = { success: 'green', skipped: 'skipped', neutral: 'neutral' }

function gate(name: string, outcome: string | undefined): Fact {
  return { name, ok: outcome === 'pass', says: outcome ?? 'no verdict' }
}

function rails(db: Db, plan: number): Fact {
  const rows = db.prepare(`SELECT rail_id, outcome FROM verdicts WHERE id IN (SELECT max(id) FROM verdicts
    WHERE plan = ? AND kind = 'rail' AND gate = 'pre_review' AND rail_id <> 'identifiers' GROUP BY rail_id)
    ORDER BY rail_id`).all(plan) as { rail_id: string; outcome: string }[]
  if (rows.length === 0) return gate('rails', undefined)
  const failing = rows.filter((r) => r.outcome !== 'pass').map((r) => `${r.rail_id} ${r.outcome}`)
  return { name: 'rails', ok: failing.length === 0, says: failing.length === 0 ? 'pass' : failing.join(', ') }
}

export function facts(db: Db, plan: number): Fact[] {
  const identifiers = db.prepare(`SELECT outcome FROM verdicts WHERE plan = ? AND kind = 'rail' AND rail_id = 'identifiers'
    ORDER BY id DESC LIMIT 1`).get(plan) as { outcome: string } | undefined
  const n = builds(db, plan)
  return [
    rails(db, plan),
    gate('code_quality', lastReview(db, plan, 'review')?.outcome),
    gate('senior', lastReview(db, plan, 'senior_review')?.outcome),
    gate('identifiers', identifiers?.outcome),
    { name: 'builds', ok: true, says: `${String(n)} build${n === 1 ? '' : 's'}` },
  ]
}

export function diffFacts(diff: string): Fact[] {
  const files = parse(diff)
  const lines = files.flatMap(counted)
  const of = (kind: Counted['kind']): Counted[] => lines.filter((l) => l.kind === kind)
  const comments = of('comments')
  const groups = [...new Set(comments.map((l) => l.ext))].map((ext) => `${ext} ${signed(comments.filter((l) => l.ext === ext))}`)
  return [
    { name: 'files', ok: true, says: `${String(files.length)} files` },
    { name: 'code', ok: true, says: signed(of('code')) },
    { name: 'tests', ok: true, says: signed(of('tests')) },
    { name: 'comments', ok: true, says: groups.length === 0 ? signed(comments) : `${signed(comments)} (${groups.join(', ')})` },
  ]
}

function counted(file: FileDiff): Counted[] {
  return (['added', 'removed'] as const).flatMap((side) => file[side]
    .filter((l) => l.text.trim() !== '')
    .map((l) => ({ kind: kindOf(file.path, l.text), ext: extname(file.path), side })))
}

function kindOf(path: string, text: string): Counted['kind'] {
  if (conventionsOf(path).comment.test(text)) return 'comments'
  return TEST_FILE.test(path) ? 'tests' : 'code'
}

function signed(lines: Counted[]): string {
  const added = lines.filter((l) => l.side === 'added').length
  return `+${String(added)} -${String(lines.length - added)}`
}

export function testFacts(db: Db, plan: number, diff: string, board: Board[] | null): Fact[] {
  const changed = parse(diff).filter((f) => !f.deleted && TEST_FILE.test(f.path)).length
  const gating = (board ?? []).filter((r) => r.gates)
  const ok = gating.every((r) => r.status === 'completed' && r.conclusion === 'success')
  const says = board === null || board.length === 0 ? "no fork CI; step 3's checks stand as it" : gating.map((r) => r.url ?? r.workflow).join(', ')
  return [
    { name: 'tests changed', ok: true, says: `${String(changed)} test files added or changed` },
    gate('local', lastChecks(db, plan)?.outcome),
    { name: 'fork', ok, says },
  ]
}

export function ciFacts(board: Board[]): Fact[] {
  return board.map((r) => ({ name: r.workflow, ...ciFact(r) }))
}

function ciFact(r: Board): Omit<Fact, 'name'> {
  const link = r.url === undefined ? '' : ` ${r.url}`
  if (r.status !== 'completed') return { ok: false, says: 'still running' }
  const passed = PASSED[r.conclusion]
  if (passed !== undefined) return { ok: true, says: `${passed}${link}` }
  if (r.base !== undefined) return { ok: true, says: `red on the base too (${r.base.join(', ')})` }
  const reason = REASONS.find(([, words]) => words.test(r.workflow))
  if (reason !== undefined) return { ok: true, says: `red, expected on a fork: ${reason[0]}` }
  if (!r.gates) return { ok: true, says: 'red, not judged: the diff touches no file it runs on' }
  return { ok: false, says: `red${link}` }
}

export function greptileFacts(db: Db, root: string, plan: number, head: string): Fact[] {
  const found = listed(root, plan, head)
  const lines = settled(root, plan, head)
  const row = graded(db, plan, head)
  const score = row?.score ?? 0
  return [
    row === null ? { name: 'greptile', ok: false, says: 'no score' } : { name: 'greptile', ok: score >= 4 || found.length > 0, says: `${String(score)}/5` },
    { name: 'findings', ok: true, says: `${String(found.length)} findings` },
    ...found.map(({ id }) => ({ name: id, ok: lines.has(id), says: lines.get(id) ?? 'open' })),
  ]
}

export function ruleFacts(root: string, plan: number, repo: string, row: Issue, body: string, read: Read = gh, now = new Date()): Fact[] {
  const rules = profile(root, repo)
  const dir = srcDir(root, plan)
  const no = `#${String(row.number)}`
  const logins = row.assignees.map((a) => a.login)
  const misses = unsigned(dir)
  return [
    templateFact(dir, body),
    disclosed(rules?.disclosure, body),
    new RegExp(`${no}(?!\\d)`).test(body) ? { name: 'linked', ok: true, says: `${no} linked` } : { name: 'linked', ok: false, says: `${no} not in the body` },
    logins.includes(OPERATOR) ? { name: 'assigned', ok: true, says: 'assigned to us' }
      : { name: 'assigned', ok: false, says: `assigned to ${logins.length === 0 ? 'nobody' : logins.join(', ')}` },
    { name: 'signed', ok: misses.length === 0, says: misses.length === 0 ? 'no Signed-off-by missing' : misses.join('; ') },
    paceFact(repo, rules?.intake?.pace, read, now),
  ]
}

function template(dir: string): string | undefined {
  for (const at of [join(dir, '.github'), dir, join(dir, 'docs')]) {
    const name = existsSync(at) ? readdirSync(at).find((f) => f.toLowerCase() === 'pull_request_template.md') : undefined
    if (name !== undefined) return readFileSync(join(at, name), 'utf8')
  }
  return undefined
}

function templateFact(dir: string, body: string): Fact {
  const text = template(dir)
  if (text === undefined) return { name: 'template', ok: true, says: 'no template' }
  const lines = new Set(body.split('\n').map((l) => l.trim()))
  const sections = text.split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.trim())
  const missing = sections.filter((s) => !lines.has(s))
  if (missing.length === 0) return { name: 'template', ok: true, says: `${String(sections.length)} sections present` }
  return { name: 'template', ok: false, says: `missing ${missing.join(', ')}` }
}

function disclosed(disclosure: string | undefined, body: string): Fact {
  if (disclosure === undefined) return { name: 'disclosure', ok: true, says: 'no disclosure rule' }
  const flat = (s: string): string => s.replace(/\s+/g, ' ')
  const ok = flat(body).includes(flat(disclosure).trim())
  return { name: 'disclosure', ok, says: ok ? 'present' : 'missing' }
}

function paceFact(repo: string, pace: NonNullable<Profile['intake']>['pace'], read: Read, now: Date): Fact {
  if (pace === undefined) return { name: 'pace', ok: true, says: 'no pace rule' }
  const says = paced(repo, pace, read, now)
  return says === null ? { name: 'pace', ok: true, says: `under ${String(pace.prs)} in ${String(pace.days)} days` } : { name: 'pace', ok: false, says }
}
