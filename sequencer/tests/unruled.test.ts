import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { unruled } from '../unruled.ts'
import { put } from '../workspace.ts'

const SHA = 'a'.repeat(40)

const badge = (p: number): string => `<img alt="P${String(p)}" src="https://greptile.com/p.svg">`

const at = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'cf-unruled-'))
  for (const [name, body] of Object.entries(files)) put(root, 1, name, body)
  return root
}

test('D6 P3 findings hold nothing; one with no badge holds', () => {
  const root = at({ [`findings-${SHA}.md`]: `- G1 src/a.ts:1 ${badge(3)} style\n- G2 src/a.ts:2 no badge here\n` })
  expect(unruled(root, 1, SHA)).toEqual({ found: 2, ruled: [], open: ['G2'] })
})

test('a badge on a later line of a body counts', () => {
  const root = at({ [`findings-${SHA}.md`]: `- G1 src/a.ts:1 **Title**\n\n${badge(3)} style\n- G2 src/a.ts:2 **Bug**\n${badge(1)}\n` })
  expect(unruled(root, 1, SHA)).toEqual({ found: 2, ruled: [], open: ['G2'] })
})

test('D2 an overruled line in issue.md rules a finding', () => {
  const root = at({ [`findings-${SHA}.md`]: `- G1 src/a.ts:1 ${badge(2)} x\n- G2 src/a.ts:2 ${badge(2)} y\n`,
    'issue.md': '# Issue\n\n## Answer from the director (2026-10-05)\n\nG1, G2 overruled: src/a.ts:1 already refuses it\n' })
  expect(unruled(root, 1, SHA)).toEqual({ found: 2, ruled: ['G1', 'G2'], open: [] })
})

test('D5 overruled with an empty reason leaves it open', () => {
  const root = at({ [`findings-${SHA}.md`]: `- G1 src/a.ts:1 ${badge(2)} x\n`, 'rulings.md': 'G1 overruled:   \n' })
  expect(unruled(root, 1, SHA)).toEqual({ found: 1, ruled: [], open: ['G1'] })
})

test('D7 an accepted block at the head rules a finding', () => {
  const rulings = `accepted:\n  head: ${SHA.slice(0, 12)}\n  ids: G1\n  reason: recorded upstream\n`
  const found = `- G1 src/a.ts:1 ${badge(0)} x\n- G2 src/a.ts:2 ${badge(2)} y\n`
  const root = at({ [`findings-${SHA}.md`]: found, [`findings-${'b'.repeat(40)}.md`]: found, 'rulings.md': rulings })
  expect(unruled(root, 1, SHA)).toEqual({ found: 2, ruled: ['G1'], open: ['G2'] })
  expect(unruled(root, 1, 'b'.repeat(40))).toEqual({ found: 2, ruled: [], open: ['G1', 'G2'] })
})
