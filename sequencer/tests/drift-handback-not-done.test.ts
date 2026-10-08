import { expect, test } from 'vitest'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

test('handback_not_done is quiet with no refusal', () => {
  const line = REGISTRY.filter((e) => e.name === 'handback_not_done')
  expect(line).toHaveLength(1)
  expect(drift(db(), line, NOW)).toEqual([])
})
