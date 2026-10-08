import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { unruled } from '../unruled.ts'
import { put, srcDir } from '../workspace.ts'

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

test('D5 two overrules on one line rule both', () => {
  const root = at({ [`findings-${SHA}.md`]: `- G4188597529 src/a.ts:1 ${badge(2)} x\n- G4188597530 src/a.ts:2 ${badge(2)} y\n`,
    'issue.md': '- G4188597529 overruled: src/a.ts:1 already refuses it. G4188597530 overruled: the reference does the same\n' })
  expect(unruled(root, 1, SHA)).toEqual({ found: 2, ruled: ['G4188597529', 'G4188597530'], open: [] })
})

test('D5 overruled with an empty reason leaves it open', () => {
  const root = at({ [`findings-${SHA}.md`]: `- G1 src/a.ts:1 ${badge(2)} x\n`, 'rulings.md': 'G1 overruled:   \n' })
  expect(unruled(root, 1, SHA)).toEqual({ found: 1, ruled: [], open: ['G1'] })
})

test('D1 D7 an accepted block rules a finding at every head', () => {
  const rulings = `accepted:\n  head: ${SHA.slice(0, 12)}\n  ids: G1\n  reason: recorded upstream\n`
  const found = `- G1 src/a.ts:1 ${badge(0)} x\n- G2 src/a.ts:2 ${badge(2)} y\n`
  const root = at({ [`findings-${SHA}.md`]: found, [`findings-${'b'.repeat(40)}.md`]: found, 'rulings.md': rulings })
  expect(unruled(root, 1, SHA)).toEqual({ found: 2, ruled: ['G1'], open: ['G2'] })
  expect(unruled(root, 1, 'b'.repeat(40))).toEqual({ found: 2, ruled: ['G1'], open: ['G2'] })
})

test('D2 a summary link is a finding graded by its own badge', () => {
  const link = (n: number): string => `<a href="https://github.com/o/r/pull/15#discussion_r${String(n)}">▶</a>`
  const summary = ['Confidence Score: 0/5', `1. ${badge(1)}&nbsp;**Bug** ${link(7)}`, `2. ${badge(3)}&nbsp;**Style** ${link(8)}`,
    `3. **No badge** ${link(9)}`, `4. ${badge(3)}&nbsp;**Again** ${link(1)}`,
    '<a href="https://app.greptile.com/retrigger">Retrigger</a> <a href="https://github.com/o/r/commit/abc">abc</a>'].join('\n')
  const root = at({ [`findings-${SHA}.md`]: `- G1 src/a.ts:1 ${badge(2)} x\n` })
  expect(unruled(root, 1, SHA, summary)).toEqual({ found: 4, ruled: [], open: ['G1', 'G7', 'G9'] })
})

const onDiff = (files: Record<string, string>): string => {
  const root = at({ ...files, 'findings.paths': 'G1 harness/src/artifacts.ts\nG2 php/src/Config.php\nG4 harness/src/Charge.ts\n' })
  mkdirSync(join(srcDir(root, 1), 'php/src'), { recursive: true })
  writeFileSync(join(srcDir(root, 1), 'php/src/Config.php'), '<?php\n')
  return root
}

test('D1 D2 an off-diff finding is found but not open', () => {
  const root = onDiff({ [`findings-${SHA}.md`]: `- G1 harness/src/artifacts.ts:1 ${badge(1)} x\n- G2 php/src/Config.php:1 ${badge(2)} y\n- G3 php/src/Other.php:1 ${badge(0)} z\n` })
  expect(unruled(root, 1, SHA)).toEqual({ found: 3, ruled: [], open: ['G2', 'G3'] })
})

test('D4 off-diff P1s and overruled P2s pass at 3/5', () => {
  const link = (n: number): string => `<a href="https://github.com/o/r/pull/18#discussion_r${String(n)}">▶</a>`
  const summary = [`1. ${badge(1)}&nbsp;**Bug** ${link(1)}`, `2. ${badge(1)}&nbsp;**Bug** ${link(4)}`].join('\n')
  const root = onDiff({ [`findings-${SHA}.md`]: `- G2 php/src/Config.php:1 ${badge(2)} y\n- G5 php/src/Config.php:2 ${badge(2)} w\n`,
    'rulings.md': 'G2, G5 overruled: Config.php already refuses it\n' })
  expect(unruled(root, 1, SHA, summary)).toEqual({ found: 4, ruled: ['G2', 'G5'], open: [] })
})

test('D5 an accepted block with a bad head or no reason rules none', () => {
  const rulings = `accepted:\n  head: not-a-sha\n  ids: G1\n  reason: recorded\n\naccepted:\n  head: ${SHA.slice(0, 12)}\n  ids: G2\n  reason:\n`
  const root = at({ [`findings-${SHA}.md`]: `- G1 src/a.ts:1 ${badge(2)} x\n- G2 src/a.ts:2 ${badge(2)} y\n`, 'rulings.md': rulings })
  expect(unruled(root, 1, SHA)).toEqual({ found: 2, ruled: [], open: ['G1', 'G2'] })
})
