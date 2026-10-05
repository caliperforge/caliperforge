import { expect, it } from 'vitest'
import { FORK, SELF } from '../sequencer/workspace.ts'
import { DEFAULT_BUILDER } from '../templates/pr-path.ts'
import { LANE } from './lanes.ts'

it('D3 LANE literals match the constants they replaced', () => {
  expect(LANE.machine).toMatchObject({ seat: DEFAULT_BUILDER, home: SELF })
  expect(LANE.atelier.home).toBe(`${FORK}/atelier`)
  expect(LANE.uniswap.home).toBe(`${FORK}/v4-hook-index`)
})
