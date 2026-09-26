import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import type { Failure } from '../../../sequencer/checks.ts'
import type { Verdict } from '../../record.ts'
import { checked } from '../index.ts'

const DIFF = '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n'

const LINT: Failure = { script: 'lint', command: 'npm run lint', code: '3', output: 'lint is red', tests: [], retried: false }
const TEST: Failure = { script: 'test', command: 'npm run test', code: '1', output: ' FAIL x.test.ts > a call\nAssertionError: expected "hi" to be "ho"\n', tests: [], retried: false }

const verdict = (failed: Failure): Verdict => checked(failed, DIFF)

test('a script that exits non-zero refuses over the one span it ran in, owned by the rail', () => {
  expect(verdict(LINT)).toMatchObject({
    outcome: 'refuse', spans: ['checks:lint'], origin_kind: 'rail', origin_ref: 'checks',
    subject_digest: createHash('sha256').update(DIFF).digest('hex'),
  })
})

test('a lint reporter that opens a line with the same glyph still names the rail', () => {
  expect(verdict({ ...LINT, output: '   × no-unused-vars  src/x.ts:3\n' }).origin_ref).toBe('checks')
})

test('a test failure carries the first failing test as its origin', () => {
  expect(verdict(TEST)).toMatchObject({ spans: ['checks:test'], origin_kind: 'rail', origin_ref: 'x.test.ts > a call' })
  expect(verdict({ ...TEST, output: '   × a lap 1066ms\n     → expected 1066 to be less than 1000\n' }).origin_ref)
    .toBe('a lap')
})

test('no failure passes with no span and no origin', () => {
  expect(checked(null, DIFF)).toMatchObject({ outcome: 'pass', spans: [], origin_kind: null, origin_ref: null })
})
