import { join } from 'node:path'
import { expect, test } from 'vitest'
import { packs } from '../../../reviews/packs.ts'
import { seat } from '../../../runner/rules.ts'
import { languageSeat } from '../../../runner/tests/language-seat.ts'

const root = join(import.meta.dirname, '../../..')

languageSeat({
  seat: 'ruby_specialist',
  language: 'ruby',
  commands: ['Bash(just:*)', 'Bash(bundle install:*)', 'Bash(bundle exec:*)'],
  allowed: ['just --justfile ruby/Justfile test', 'just --justfile ruby/Justfile lint', 'bundle exec standardrb', 'bundle install'],
  listed: 'ruby/lib/pay_kit/config.rb',
  beside: 'python/src/solana_pay_kit/config.py',
  mode: 'build',
})

test('the prompt says every test run is in the foreground', () => {
  expect(seat(root, 'ruby_specialist').prompt).toContain('Every test run is in the foreground; wait for it to finish.')
})

test('the prompt names no pay-kit or Solana rule', () => {
  expect(seat(root, 'ruby_specialist').prompt).not.toMatch(/pay-kit|Pay-kit|Solana/)
})

test('D1: What to check opens the prompt with the Ruby checks', () => {
  const { prompt } = seat(root, 'ruby_specialist')
  expect(prompt.startsWith('# ruby_specialist\n\n## What to check\n')).toBe(true)
  const checks = prompt.slice(0, prompt.indexOf('## Test conventions'))
  for (const word of ['empty', 'zero or negative', 'yes', 'lowercase']) expect(checks).toContain(word)
})

test('D2: the build mode, not the prompt, holds the framing', () => {
  const { prompt } = seat(root, 'ruby_specialist')
  expect(prompt).not.toContain('You build')
  expect(prompt).not.toContain('- id: D1')
  const build = seat(root, 'ruby_specialist', 'build').prompt.replace(/\s+/g, ' ')
  expect(build).toContain('You build')
  expect(build).toContain('- id: D1')
  expect(build).toContain(
    'On an outside plan you may write only the files the brief lists under `## Files`; otherwise, only inside the seat\'s write paths. Any other write is refused and the step ends there.',
  )
})

test('D3: review mode reads What to check before the profile', () => {
  const p = 'ruby/lib/config.rb'
  const out = packs(root, `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new\n`, null)
  const at = out.indexOf('## What to check')
  expect(at).toBeGreaterThan(-1)
  expect(at).toBeLessThan(out.indexOf('## Profile'))
})
