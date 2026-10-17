import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fresh, rejects } from '../checks/sqlite.ts'
import type { Read } from '../cli/gh.ts'
import { add } from '../cli/plan.ts'
import { FORK, SELF } from '../sequencer/workspace.ts'
import { DEFAULT_BUILDER } from '../templates/pr-path.ts'
import { LANE, LANES, laneOf } from './lanes.ts'
import { pipeNamed, planById } from './plans.ts'

const schema = join(import.meta.dirname, '../schema')

const SCIENCE = [['rubin', 'vo-conformance'], ['bio', 'vcf-conformance']] as const

const issue = (repo: string): string => `https://github.com/${FORK}/${repo}/issues/1`

const row = (lane: string, repo: string): string => `INSERT INTO plans (pipe_id, template, state, queued_at, lane, seat, origin)
  VALUES ((SELECT id FROM pipes WHERE name = 'bench'), 'pr_path', 'queued', '2026-10-17', '${lane}', 'python_specialist', '${issue(repo)}')`

const canned = (lane: string, repo: string): Read => () =>
  ({ number: 1, title: 'Conform', body: 'the ask', url: issue(repo), labels: [{ name: `lane:${lane}` }] })

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
