import { expect, test } from 'vitest'
import { prose } from '../prose.ts'

test('a fence that parses neither way reads as null', () => {
  expect(prose('list: [a, b', ['why'])).toBeNull()
})

test('an alias with no anchor reads as null', () => {
  expect(prose('why: one\nother: *x', ['why'])).toBeNull()
})

test('a prose value that opens with # reads as that string', () => {
  expect(prose('why: # one', ['why'])).toEqual({ why: '# one' })
})
