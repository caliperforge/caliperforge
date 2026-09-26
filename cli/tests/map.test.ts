import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { map, write } from '../map.ts'

const text = map(join(import.meta.dirname, '../..'))
const paths = [...text.matchAll(/^- `(.+?)`/gm)].map((m) => m[1])

test('every non-test .ts file, sorted, with its purpose and exports', () => {
  expect(text).toContain('- `store/verdict.ts` — The one verdict shape: a rail and a review both end in a `verdicts` row.\n  - Verdict\n')
  expect(text).toContain('- `cli/map.ts` — The repo map: every source file, its purpose and its exports, for the seats that read a checkout.\n  - MAP\n  - map\n  - write\n')
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

test('write puts the map of a tree at its root', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-map-'))
  writeFileSync(join(root, 'a.ts'), '/** One constant. */\nexport const a = 1\n')
  expect(readFileSync(write(root), 'utf8')).toBe('# MAP.md — written by `cf map`\n\n- `a.ts` — One constant.\n  - a\n')
})

test('the map is never committed', () => {
  expect(readFileSync(join(import.meta.dirname, '../../.gitignore'), 'utf8').split('\n')).toContain('MAP.md')
})
