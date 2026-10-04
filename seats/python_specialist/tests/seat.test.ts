import { join } from 'node:path'
import { expect, test } from 'vitest'
import { packs } from '../../../reviews/packs.ts'
import { seat } from '../../../runner/rules.ts'
import { languageSeat } from '../../../runner/tests/language-seat.ts'

languageSeat({
  seat: 'python_specialist',
  language: 'python',
  commands: ['Bash(uv run:*)', 'Bash(uv sync:*)', 'Bash(just:*)'],
  allowed: ['just --justfile python/Justfile test', 'uv run --directory python pytest', 'uv run --directory python ruff check', 'uv sync --directory python --extra dev'],
  listed: 'python/src/solana_pay_kit/config.py',
  beside: 'ruby/lib/pay_kit/config.rb',
  mode: 'build',
})

test('the prompt says every command runs in the foreground', () => {
  expect(seat(join(import.meta.dirname, '../../..'), 'python_specialist').prompt).toContain(
    'Every command runs in the foreground; wait for it to finish, and answer only after it has.',
  )
})

test('the prompt names no pay-kit or Solana rule', () => {
  expect(seat(join(import.meta.dirname, '../../..'), 'python_specialist').prompt).not.toMatch(/pay-kit|Pay-kit|Solana/)
})

test('D1: What to check opens the prompt with the Python checks', () => {
  const { prompt } = seat(join(import.meta.dirname, '../../..'), 'python_specialist')
  expect(prompt.startsWith('# python_specialist\n\n## What to check\n')).toBe(true)
  const checks = prompt.slice(0, prompt.indexOf('## Profile'))
  for (const word of ['reference implementation', 'ruff', 'pyright']) expect(checks).toContain(word)
})

test('D2: review mode reads What to check before the profile', () => {
  const p = 'python/client.py'
  const out = packs(join(import.meta.dirname, '../../..'), `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new\n`, null)
  const at = out.indexOf('## What to check')
  expect(at).toBeGreaterThan(-1)
  expect(at).toBeLessThan(out.indexOf('## Profile'))
})
