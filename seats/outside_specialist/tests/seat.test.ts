import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Seat, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')

test('the manifest fences writes to the files the brief names', () => {
  expect(Seat.parse(seat(root, 'outside_specialist').manifest)).toMatchObject({
    seat: 'outside_specialist',
    write_paths: ['brief:files'],
  })
})

test('it holds no shell', () => {
  expect(seat(root, 'outside_specialist').manifest.tools.some((t) => t.startsWith('Bash'))).toBe(false)
})

test('the roster carries the seat', () => {
  expect(rules(root).find((r) => r.id === 'outside_specialist')).toMatchObject({ kind: 'card' })
})
