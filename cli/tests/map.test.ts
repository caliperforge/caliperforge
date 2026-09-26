import { join } from 'node:path'
import { expect, test } from 'vitest'
import { map } from '../map.ts'

const text = map(join(import.meta.dirname, '../..'))
const paths = [...text.matchAll(/^- `(.+?)`/gm)].map((m) => m[1])

test('every non-test .ts file, sorted, with its purpose and exports', () => {
  expect(text).toContain('- `store/verdict.ts` — The one verdict shape: a rail and a review both end in a `verdicts` row.\n  - Verdict\n')
  expect(text).toContain('- `cli/map.ts`\n  - map\n')
  expect(paths).not.toContain('cli/tests/digests.test.ts')
  expect(paths).not.toContain('runner/tests/language-seat.ts')
  expect(paths).toEqual([...paths].sort())
})

test('a shebang is not a purpose', () => {
  expect(text).toContain('- `cli/cf.ts`\n')
})

test('the map of this repo stays under 40,000 characters', () => {
  expect(text.length).toBeLessThan(40_000)
})
