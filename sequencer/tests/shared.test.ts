import { expect, test } from 'vitest'
import { at } from '../../templates/pr-path.ts'
import { fingerprintOf } from '../index.ts'

const text = (note: string) => ({ outcome: 'refuse' as const, spans: ['text:5 identifier.unresolved'], note })
const base = (note: string) => ({ outcome: 'refuse' as const, spans: ['base:stale'], note })

test('text spans differ by what they name', () => {
  expect(fingerprintOf(at(3), text('identifiers: cli/extra.ts'))).not.toBe(fingerprintOf(at(3), text('identifiers: schema/0036_x.sql')))
  expect(fingerprintOf(at(3), text('identifiers: cli/extra.ts'))).toBe(fingerprintOf(at(3), text('identifiers: cli/extra.ts')))
})

test('other spans still match on the span alone', () => {
  expect(fingerprintOf(at(6), base('behind main'))).toBe(fingerprintOf(at(6), base('behind main again')))
})
