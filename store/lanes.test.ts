import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fresh, rejects } from '../checks/sqlite.ts'
import type { Read } from '../cli/gh.ts'
import { add } from '../cli/plan.ts'
import { intake } from '../sequencer/capture.ts'
import { FORK, SELF } from '../sequencer/workspace.ts'
import { DEFAULT_BUILDER } from '../templates/pr-path.ts'
import { homes } from './homes.ts'
import { LANE, LANES, laneOf } from './lanes.ts'
import { allPlans, pipeNamed, planById } from './plans.ts'

const schema = join(import.meta.dirname, '../schema')

const SCIENCE = [['rubin', 'vo-conformance'], ['bio', 'vcf-conformance']] as const

const issue = (repo: string): string => `https://github.com/${FORK}/${repo}/issues/1`

const row = (lane: string, repo: string): string => `INSERT INTO plans (pipe_id, template, state, queued_at, lane, seat, origin)
  VALUES ((SELECT id FROM pipes WHERE name = 'bench'), 'pr_path', 'queued', '2026-10-17', '${lane}', 'python_specialist', '${issue(repo)}')`

const asked = (lane: string, repo: string) =>
  ({ number: 1, title: 'Conform', body: 'the ask', url: issue(repo), labels: [{ name: `lane:${lane}` }] })

const canned = (lane: string, repo: string): Read => () => asked(lane, repo)

const RUBIN = ['vo-conformance', 'rubin-alert-monitor']

const nameOf = (repo: unknown): string => String(repo).split('/').at(-1) ?? ''

function listing(log: string[]): Read {
  return (args) => {
    if (args[0] === 'api') return {}
    if (args[1] === 'view') return asked('rubin', nameOf(args[4]))
    if (args[5] === 'closed') return []
    log.push(String(args[3]))
    const open = { ...asked('rubin', nameOf(args[3])), createdAt: '2026-10-17T09:00:00Z', closedAt: null, stateReason: null }
    return RUBIN.includes(nameOf(args[3])) ? [open] : []
  }
}

it('D3 LANE literals match the constants they replaced', () => {
  expect(LANE.machine).toMatchObject({ seat: DEFAULT_BUILDER, home: SELF })
  expect(LANE.loupe.home).toBe(`${FORK}/atelier-web`)
  expect(LANE.uniswap.home).toBe(`${FORK}/v4-hook-index`)
})

it('1157a D1 the bench lane builds fuzz-bench on its own pipe', () => {
  expect(LANE.bench).toEqual({ template: 'pr_path', seat: 'solidity_specialist', home: `${FORK}/fuzz-bench`, pipe: 'bench' })
  expect(laneOf([{ name: 'lane:bench' }])).toBe('bench')
})

it('1156a D1 the site lane builds site on its own pipe', () => {
  expect(LANE.site).toEqual({ template: 'pr_path', seat: 'web_specialist', home: `${FORK}/site`, pipe: 'site' })
  expect(laneOf([{ name: 'lane:site' }])).toBe('site')
})

it('1247a D4 D5 the loupe lane builds atelier-web on its pipe', () => {
  expect(LANE.loupe).toEqual({ template: 'pr_path', seat: 'web_specialist', home: `${FORK}/atelier-web`, pipe: 'loupe' })
  expect(laneOf([{ name: 'lane:loupe' }])).toBe('loupe')
  expect(laneOf([{ name: 'lane:atelier' }])).toBe('loupe')
})

it('1247c D1 atelier is no longer a lane', () => {
  expect(Object.keys(LANE)).not.toContain('atelier')
  expect(LANES).not.toContain('atelier')
})

it('1437 D1 rubin and bio build their homes on their own pipes', () => {
  for (const [lane, repo] of SCIENCE) {
    expect(LANE[lane]).toEqual({ template: 'pr_path', seat: 'python_specialist', home: `${FORK}/${repo}`, pipe: lane })
    expect(laneOf([{ name: `lane:${lane}` }])).toBe(lane)
  }
})

it('1437 D2 the rubin and bio pipes ship on, all day, two wide', () => {
  const db = fresh(schema)
  for (const [lane] of SCIENCE) {
    expect(pipeNamed(db, lane)).toMatchObject({ enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 2 })
  }
})

it('1437 D3 plans take rubin and bio and no unlisted lane', () => {
  const db = fresh(schema)
  for (const [lane, repo] of SCIENCE) expect(rejects(db, row(lane, repo))).toBe(false)
  expect([1, 2].map((id) => planById(db, id).lane)).toEqual(['rubin', 'bio'])
  expect(rejects(fresh(schema), row('solana', 'vo-conformance'))).toBe(true)
})

it('1437 D4 a rubin or bio issue queues on its pipe', () => {
  for (const [lane, repo] of SCIENCE) {
    const db = fresh(schema)
    const filed = add(db, mkdtempSync(join(tmpdir(), 'cf-science-')), `${FORK}/${repo}#1`, 'ceo', undefined, canned(lane, repo))
    expect(filed).toMatchObject({ state: 'queued', lane, seat: 'python_specialist' })
    expect(planById(db, Number(filed.plan)).pipe_id).toBe(pipeNamed(db, lane)?.id)
  }
})

it('1486 D1 rubin has two homes and every other lane one', () => {
  expect(homes('rubin')).toEqual(RUBIN.map((r) => `${FORK}/${r}`))
  for (const l of LANES.filter((n) => n !== 'rubin')) expect(homes(l)).toEqual([LANE[l].home])
})

it('1486 D2 a lane:rubin issue from either home queues on rubin', () => {
  for (const repo of RUBIN) {
    const db = fresh(schema)
    const filed = add(db, mkdtempSync(join(tmpdir(), 'cf-rubin-')), `${FORK}/${repo}#1`, 'ceo', undefined, canned('rubin', repo))
    expect(filed).toMatchObject({ state: 'queued', lane: 'rubin', seat: 'python_specialist' })
    expect(planById(db, Number(filed.plan)).pipe_id).toBe(pipeNamed(db, 'rubin')?.id)
  }
})

it('1486 D3 intake lists both rubin homes onto the rubin pipe', () => {
  const db = fresh(schema)
  const log: string[] = []
  intake(db, mkdtempSync(join(tmpdir(), 'cf-rubin-')), listing(log))
  expect(log).toEqual(expect.arrayContaining(RUBIN.map((r) => `${FORK}/${r}`)))
  expect(allPlans(db).map((p) => ({ origin: p.origin, lane: p.lane, pipe: p.pipe_id }))).toEqual(
    RUBIN.map((r) => ({ origin: issue(r), lane: 'rubin', pipe: pipeNamed(db, 'rubin')?.id })))
})

it('1486 D4 a lane:rubin issue elsewhere names both homes', () => {
  const filed = add(fresh(schema), mkdtempSync(join(tmpdir(), 'cf-rubin-')), `${FORK}/vcf-conformance#1`, 'ceo', undefined,
    canned('rubin', 'vcf-conformance'))
  expect(filed).toMatchObject({ state: 'refused', origin: { origin_ref: 'plan.lane_home' } })
  expect(filed.why).toContain(`the rubin lane builds in ${FORK}/vo-conformance or ${FORK}/rubin-alert-monitor`)
})
