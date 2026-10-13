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
