import { join } from 'node:path'
import { expect, test } from 'vitest'
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
