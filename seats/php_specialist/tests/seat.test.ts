import { join } from 'node:path'
import { expect, test } from 'vitest'
import { packs } from '../../../reviews/packs.ts'
import { seat } from '../../../runner/rules.ts'
import { languageSeat } from '../../../runner/tests/language-seat.ts'

const root = join(import.meta.dirname, '../../..')

languageSeat({
  seat: 'php_specialist',
  language: 'php',
  commands: ['Bash(composer:*)', 'Bash(php -l:*)', 'Bash(just:*)'],
  allowed: ['composer -d php test', 'composer -d php run lint', 'just --justfile php/Justfile test', 'php -l php/src/Config.php'],
  listed: 'php/src/Config.php',
  beside: 'go/config.go',
  mode: 'build',
})

test('the prompt says every test run is in the foreground', () => {
  expect(seat(root, 'php_specialist').prompt).toContain('Every test run is in the foreground; wait for it to finish.')
})

test('the prompt names no pay-kit or Solana rule', () => {
  expect(seat(root, 'php_specialist').prompt).not.toMatch(/pay-kit|Pay-kit|Solana/)
})

test('D1: What to check opens the prompt with the PHP checks', () => {
  const { prompt } = seat(root, 'php_specialist')
  expect(prompt.startsWith('# php_specialist\n\n## What to check\n')).toBe(true)
  const checks = prompt.slice(0, prompt.indexOf('## Test conventions'))
  for (const word of ["format('c')", 'microseconds', '23:59:60Z', 'last day of the month']) expect(checks).toContain(word)
})

test('D2: the build mode, not the prompt, holds the framing', () => {
  const { prompt } = seat(root, 'php_specialist')
  expect(prompt).not.toContain('You build')
  expect(prompt).not.toContain('- id: D1')
  const build = seat(root, 'php_specialist', 'build').prompt.replace(/\s+/g, ' ')
  expect(build).toContain('You build')
  expect(build).toContain('- id: D1')
  expect(build).toContain(
    'On an outside plan you may write only the files the brief lists under `## Files`; otherwise, only inside the seat\'s write paths. Any other write is refused and the step ends there.',
  )
})

test('D3: review mode reads What to check before the profile', () => {
  const p = 'php/src/Config.php'
  const out = packs(root, `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new\n`, null)
  const at = out.indexOf('## What to check')
  expect(at).toBeGreaterThan(-1)
  expect(at).toBeLessThan(out.indexOf('## Profile'))
})
