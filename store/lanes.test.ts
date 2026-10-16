import { expect, it } from 'vitest'
import { FORK, SELF } from '../sequencer/workspace.ts'
import { DEFAULT_BUILDER } from '../templates/pr-path.ts'
import { LANE, laneOf } from './lanes.ts'

it('D3 LANE literals match the constants they replaced', () => {
  expect(LANE.machine).toMatchObject({ seat: DEFAULT_BUILDER, home: SELF })
  expect(LANE.atelier.home).toBe(`${FORK}/atelier-web`)
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
  expect(laneOf([{ name: 'lane:atelier' }])).toBe('atelier')
})
