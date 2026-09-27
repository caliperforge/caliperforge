import { join } from 'node:path'
import { expect, test } from 'vitest'
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
})

test('the prompt says every test run is in the foreground', () => {
  expect(seat(root, 'ruby_specialist').prompt).toContain('Every test run is in the foreground; wait for it to finish.')
})
