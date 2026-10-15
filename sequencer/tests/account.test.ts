import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { built } from '../../store/deliverables.ts'
import { kindsOf } from '../../store/events.ts'
import { addRule } from '../../store/index.ts'
import { set, zone } from '../../store/lanes.ts'
import { allPlans, dropPlan, planById, putPlan, type PlanRow } from '../../store/plans.ts'
import { addAccount, putTarget, targetRows } from '../../store/targets.ts'
import { brief, ideas, log, reading } from '../../templates/account.ts'
import { tick } from '../index.ts'
import { route } from '../next.ts'
import { mapOf } from '../steps.ts'
import { maybe, put } from '../workspace.ts'
import { stub, world, type World } from './world.ts'

const DAY = '2026-10-14'

const AT = `${DAY}T00:00:00.000Z`

const FILE = 'accounts/evm-security.md'

const accounted = (ask = '# Weekly\n\n**Account:** evm-security\n'): World => {
  const w = world()
  dropPlan(w.db, 1)
  putPlan(w.db, { id: 2, pipe_id: 1, target_id: null, template: 'account', state: 'queued', queued_at: AT, step: 0, retries: 0 })
  put(w.root, 2, 'ask.md', ask)
  cpSync(join(import.meta.dirname, '../../accounts'), join(w.root, 'accounts'), { recursive: true })
  return w
}

const idea = (repo: string, issue: number): object => ({ repo, issue, why: 'it fits', size: 'small' })

const skills = (w: World): void => {
  addAccount(w.db, { id: 2, repo: 'pashov/skills', measured_at: DAY, maintainers: 1, doors: 1, last_outsider_merge: DAY,
    open_pr_age_p50_days: 1, cross_repo_activity: 1, pulse: 'warm', evidence: 'https://github.com/pashov/skills' })
}

const BRIEFS = 'accounts/briefs/evm-security'

const today = (offset = 0): string => new Date(Date.now() + offset * 60000).toISOString().slice(0, 10)

test('D1: an account plan is stored and parsed', () => {
  const w = accounted()
  expect(allPlans(w.db).at(-1)).toMatchObject({ id: 2, template: 'account', state: 'queued' })
  expect(() => {
    putPlan(w.db, { id: 3, pipe_id: 1, target_id: null, template: 'nonsense' as PlanRow['template'], state: 'queued', queued_at: AT, step: 0, retries: 0 })
  }).toThrow(/CHECK constraint failed/)
})

test('D2: the account map, and route fires its read step', () => {
  const w = accounted()
  expect(mapOf('account').steps.map((s) => s.name)).toEqual(['read', 'brief', 'check', 'ideas', 'log'])
  expect(mapOf('account').at(1)).toMatchObject({ seat: 'account_lead', fires: 'seat', runs: 'account_lead' })
  expect(route(w.db, planById(w.db, 2), new Date())).toEqual({ fire: mapOf('account').at(0) })
})

const IDEA = '---\nideas:\n  - repo: acme/widget\n    issue: 14\n    why: it fits\n    size: small\n---\n\n'

const SOURCES = '---\nsources:\n  - url: https://a.example/doc\n    fetched_at: 2026-10-04T10:00:00Z\n    quote: Acme shipped.\n    claim: Acme shipped\n---\n'

const BRIEF = ['## Their world', '## Our work', '## Who brings us things', '## Openings', '## Ideas']
  .map((h) => `${h}\n\nAcme shipped [source:1].\n\n`).join('')

const reply = (draft = '', fences = `${IDEA}${SOURCES}`): string => `${BRIEF}${draft}${fences}`

const briefed = (w: World, text: string, seen?: (prompt: string) => void): ReturnType<typeof brief> =>
  brief(w.db, w.root, planById(w.db, 2), mapOf('account').at(1), stub('', 0, text, (p) => seen?.(p.prompt)))

beforeEach(() => { vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.resolve(new Response('Acme shipped.')))) })

afterEach(() => { vi.unstubAllGlobals() })

test('D1: ticks drive an account plan from read to done', async () => {
  const w = accounted()
  skills(w)
  for (const [id, state] of [[5, 'ready'], [6, 'parked']] as const) {
    putTarget(w.db, { id, account_id: 2, repo: 'pashov/skills', issue_no: id, named_merger: '', state, evidence_measured_at: DAY,
      evidence: `https://github.com/pashov/skills/issues/${String(id)}` })
  }
  for (let n = 0; n < 6 && planById(w.db, 2).state !== 'done'; n += 1) await tick(w.db, w.root, stub('', 0, reply()))
  expect(planById(w.db, 2).state).toBe('done')
  expect(kindsOf(w.db, 2)).toEqual(['read', 'brief', 'check', 'ideas', 'log'].map((kind) => ({ kind, outcome: 'pass' })))
  const answer = maybe(w.root, 2, 'answer.md') ?? ''
  for (const h of BRIEF.match(/^## .+$/gm) ?? []) expect(answer).toContain(h)
  expect(answer).not.toContain('---')
  expect(maybe(w.root, 2, 'sources.json')).not.toBeNull()
  expect(targetRows(w.db).slice(3)).toMatchObject([{ repo: 'acme/widget', issue_no: 14, state: 'ready' }])
  const written = readFileSync(join(w.root, BRIEFS, `${today(zone(w.db))}.md`), 'utf8')
  expect(written.split('\n')[0]).toBe('**Ready targets:** 1')
  for (const h of BRIEF.match(/^## .+$/gm) ?? []) expect(written).toContain(h)
})

test('D3: a second log on one day overwrites the brief', () => {
  const w = accounted()
  put(w.root, 2, 'answer.md', '## Their world\n\nfirst\n')
  log(w.db, w.root, planById(w.db, 2))
  put(w.root, 2, 'answer.md', '## Their world\n\nsecond\n')
  expect(log(w.db, w.root, planById(w.db, 2))).toMatchObject({ outcome: 'pass', note: `${BRIEFS}/${today(zone(w.db))}.md written; no new ## Log rows` })
  expect(readdirSync(join(w.root, BRIEFS))).toEqual([`${today(zone(w.db))}.md`])
  expect(readFileSync(join(w.root, BRIEFS, `${today(zone(w.db))}.md`), 'utf8')).toBe('**Ready targets:** 0\n\n## Their world\n\nsecond\n\n')
})

test('D4: the brief is named for the local day', () => {
  const w = accounted()
  set(w.db, 'tick.zone_offset_minutes', '-360', 'ceo', DAY)
  put(w.root, 2, 'answer.md', '## Their world\n')
  log(w.db, w.root, planById(w.db, 2))
  expect(readdirSync(join(w.root, BRIEFS))).toEqual([`${today(-360)}.md`])
})

test('D5: log with no Account line writes no brief', () => {
  const w = accounted('# Weekly\n')
  expect(log(w.db, w.root, planById(w.db, 2))).toMatchObject({ outcome: 'refuse', spans: ['ask.md'] })
  expect(existsSync(join(w.root, 'accounts/briefs'))).toBe(false)
})

test('D3: a draft with no source is refused, nothing written', async () => {
  const w = accounted()
  put(w.root, 2, 'reading.md', '# A\n')
  expect(await briefed(w, reply('## Draft\n\nHi, just checking in.\n\n')))
    .toMatchObject({ outcome: 'refuse', spans: ['account_lead.draft'], note: '## Draft cites no source: a check-in with no result' })
  expect(maybe(w.root, 2, 'answer.md')).toBeNull()
  expect(maybe(w.root, 2, 'ideas.json')).toBeNull()
})

test('D4: a missing or bad fence is refused', async () => {
  const w = accounted()
  put(w.root, 2, 'reading.md', '# A\n')
  expect(await briefed(w, reply('', SOURCES))).toMatchObject({ outcome: 'refuse', spans: ['account_lead.ideas'] })
  expect(await briefed(w, reply('', `${IDEA.replace('    issue: 14\n', '')}${SOURCES}`)))
    .toMatchObject({ outcome: 'refuse', spans: ['account_lead.ideas'] })
  expect(await briefed(w, reply('', IDEA))).toMatchObject({ outcome: 'refuse', spans: ['researcher.fence'] })
})

test('D5: a draft that cites a source passes', async () => {
  const w = accounted()
  put(w.root, 2, 'reading.md', '# A\n')
  expect(await briefed(w, reply('## Draft\n\nAcme shipped [source:1].\n\n'))).toMatchObject({ outcome: 'pass' })
  expect(maybe(w.root, 2, 'answer.md')).toContain('## Draft')
  expect(JSON.parse(maybe(w.root, 2, 'ideas.json') ?? '')).toEqual([{ repo: 'acme/widget', issue: 14, why: 'it fits', size: 'small' }])
})

test('D6: the prompt holds reading.md, and refusal.md if any', async () => {
  const w = accounted()
  put(w.root, 2, 'reading.md', '# Reading mark\n')
  let prompt = ''
  await briefed(w, reply(), (p) => { prompt = p })
  expect(prompt).toContain('# Account\n\n# Reading mark')
  expect(prompt).not.toContain('# Refused — fix what this names')
  put(w.root, 2, 'refusal.md', 'Refusal mark')
  await briefed(w, reply(), (p) => { prompt = p })
  expect(prompt).toContain('# Refused — fix what this names\n\nRefusal mark')
})

test('D3: reading.md holds the file and our rows on its repos', () => {
  const w = accounted()
  skills(w)
  putTarget(w.db, { id: 2, account_id: 2, repo: 'pashov/skills', issue_no: 5, named_merger: '', state: 'ready', evidence_measured_at: DAY,
    evidence: 'https://github.com/pashov/skills/issues/5' })
  putPlan(w.db, { id: 3, pipe_id: 1, target_id: null, template: 'pr_path', state: 'done', queued_at: AT, step: 0, retries: 0,
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/fuzz-bench/issues/9' })
  addRule(w.db, { id: 'typescript_specialist', kind: 'roster', path: 'seats/typescript_specialist', content_hash: '0'.repeat(64), loaded_at: DAY })
  built(w.db, { plan: 3, step: 2, seat: 'typescript_specialist', diff_digest: '0'.repeat(64), evidence: 'https://github.com/caliperforge/fuzz-bench/pull/10' })
  expect(reading(w.db, w.root, planById(w.db, 2))).toMatchObject({ outcome: 'pass' })
  const md = maybe(w.root, 2, 'reading.md') ?? ''
  expect(md.startsWith(readFileSync(join(w.root, FILE), 'utf8').trimEnd())).toBe(true)
  expect(md).toContain('"repo":"pashov/skills","issue_no":5')
  expect(md).toContain('"origin":"https://github.com/caliperforge/fuzz-bench/issues/9"')
  expect(md).toContain('"evidence":"https://github.com/caliperforge/fuzz-bench/pull/10"')
  expect(md).not.toContain('acme/widget')
})

test('D4: reading refuses with no Account line or no file', () => {
  const w = accounted('# Weekly\n')
  expect(reading(w.db, w.root, planById(w.db, 2))).toMatchObject({ outcome: 'refuse', spans: ['ask.md'] })
  put(w.root, 2, 'ask.md', '**Account:** nobody\n')
  expect(reading(w.db, w.root, planById(w.db, 2))).toMatchObject({ outcome: 'refuse', spans: ['accounts/nobody.md'] })
  expect(maybe(w.root, 2, 'reading.md')).toBeNull()
})

test('D5: a new idea lands ready and a parked one stays parked', () => {
  const w = accounted()
  putTarget(w.db, { id: 2, account_id: 1, repo: 'acme/widget', issue_no: 13, named_merger: '', state: 'parked', evidence_measured_at: DAY,
    evidence: 'https://github.com/acme/widget/issues/13' })
  put(w.root, 2, 'ideas.json', JSON.stringify([idea('acme/widget', 13), idea('acme/widget', 14)]))
  expect(ideas(w.db, w.root, planById(w.db, 2))).toMatchObject({ outcome: 'pass' })
  expect(targetRows(w.db).slice(1)).toMatchObject([{ issue_no: 13, state: 'parked' },
    { account_id: 1, repo: 'acme/widget', issue_no: 14, state: 'ready', evidence: 'https://github.com/acme/widget/issues/14' }])
})

test('D5: an idea on a repo with no account writes nothing', () => {
  const w = accounted()
  put(w.root, 2, 'ideas.json', JSON.stringify([idea('acme/widget', 14), idea('nobody/here', 1)]))
  expect(ideas(w.db, w.root, planById(w.db, 2))).toMatchObject({ outcome: 'refuse', note: 'no accounts row for nobody/here' })
  expect(targetRows(w.db)).toHaveLength(1)
})

test('D5: an idea listed twice lands once', () => {
  const w = accounted()
  put(w.root, 2, 'ideas.json', JSON.stringify([idea('acme/widget', 14), idea('acme/widget', 14)]))
  expect(ideas(w.db, w.root, planById(w.db, 2))).toMatchObject({ outcome: 'pass',
    note: '1 target(s) written ready, 0 already in targets, 1 repeated' })
  expect(targetRows(w.db).slice(1)).toMatchObject([{ repo: 'acme/widget', issue_no: 14, state: 'ready' }])
})

test('D6: log adds new dated rows at the end of ## Log, once', () => {
  const w = accounted()
  const path = join(w.root, FILE)
  writeFileSync(path, '# A\n\n## Log\n\n- 2026-10-01 old\n\n## Rules\n\n- one\n')
  put(w.root, 2, 'answer.md', '## Their world\n\nnot a row\n- 2026-10-01 old\n- 2026-10-14 new\n- undated row\n')
  expect(log(w.db, w.root, planById(w.db, 2))).toMatchObject({ outcome: 'pass' })
  const once = '# A\n\n## Log\n\n- 2026-10-01 old\n- 2026-10-14 new\n\n## Rules\n\n- one\n'
  expect(readFileSync(path, 'utf8')).toBe(once)
  expect(log(w.db, w.root, planById(w.db, 2))).toMatchObject({ outcome: 'pass' })
  expect(readFileSync(path, 'utf8')).toBe(once)
})

test('D6: an account file with no ## Log is refused', () => {
  const w = accounted()
  writeFileSync(join(w.root, FILE), '# A\n')
  put(w.root, 2, 'answer.md', '- 2026-10-14 new\n')
  expect(log(w.db, w.root, planById(w.db, 2))).toMatchObject({ outcome: 'refuse', spans: [FILE] })
})
