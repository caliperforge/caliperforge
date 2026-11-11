import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { excused } from '../excused.ts'
import { put } from '../workspace.ts'

const SHA = 'a'.repeat(40)
const RED = 'https://github.com/o/r/actions/runs/7'
const BOARD = [{ workflow: 'keychain-307', status: 'completed', conclusion: 'failure', gates: false, url: RED }]

const at = (rulings: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'cf-excused-'))
  put(root, 1, 'rulings.md', rulings)
  return root
}

const excuse = (head: string, reason = 'the runner lost its keychain', spans = 'ci.red keychain-307'): string =>
  `overruled:\n  head: ${head}\n  spans: ${spans}\n  reason: ${reason}\n`

test('an overruled block excuses its red run at its head only', () => {
  const root = at(excuse(SHA.slice(0, 12)))
  expect(excused(root, 1, SHA, [`${RED} ci.red`], BOARD)).toBe(true)
  expect(excused(root, 1, 'b'.repeat(40), [`${RED} ci.red`], BOARD)).toBe(false)
  expect(excused(root, 1, SHA, [`${RED} ci.red`, 'commit:1 upstream.number'], BOARD)).toBe(false)
  expect(excused(root, 1, SHA, [], BOARD)).toBe(false)
})

test('a block with no reason or another run excuses none', () => {
  for (const rulings of [excuse(SHA.slice(0, 12), ''), excuse(SHA.slice(0, 12), 'flaky', 'ci.red src CI')]) {
    expect(excused(at(rulings), 1, SHA, [`${RED} ci.red`], BOARD)).toBe(false)
  }
})
