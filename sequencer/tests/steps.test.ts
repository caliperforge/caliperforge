import { expect, test } from 'vitest'
import { steps as comms } from '../../templates/comms.ts'
import { at, steps } from '../../templates/pr-path.ts'
import { mapOf } from '../steps.ts'

test('a comms plan steps through templates/comms.ts', () => {
  for (const n of [0, 1, 2]) expect(mapOf('comms').at(n)).toEqual(comms[n])
  expect(mapOf('comms').at(1).name).toBe('review')
})

test('a step no map has throws, and research has none', () => {
  expect(() => mapOf('comms').at(3)).toThrow('comms has no step 3')
  expect(() => mapOf('research').at(0)).toThrow('research has no step 0')
  expect(mapOf('research').steps).toEqual([])
})

test('a pr_path plan steps as templates/pr-path.ts does', () => {
  for (const { step } of steps) {
    for (const lang of [null, 'kotlin']) expect(mapOf('pr_path').at(step, lang)).toEqual(at(step, lang))
  }
  expect(mapOf('pr_path').last(8)).toBe(true)
})
