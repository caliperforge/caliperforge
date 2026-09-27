import { join } from 'node:path'
import { expect, test } from 'vitest'
import { seat } from '../../../runner/rules.ts'
import { languageSeat } from '../../../runner/tests/language-seat.ts'

const root = join(import.meta.dirname, '../../..')

languageSeat({
  seat: 'lua_specialist',
  language: 'lua',
  commands: ['Bash(just:*)', 'Bash(luajit:*)', 'Bash(luacheck:*)', 'Bash(busted:*)'],
  allowed: ['just --justfile lua/Justfile test', 'just --justfile lua/Justfile lint', 'luacheck lua/pay_kit', 'luajit tests/run.lua'],
  listed: 'lua/pay_kit/internal/config.lua',
  beside: 'ruby/lib/pay_kit/config.rb',
})

test('the prompt says every test run is in the foreground', () => {
  expect(seat(root, 'lua_specialist').prompt).toContain('Every test run is in the foreground; wait for it to finish.')
})
