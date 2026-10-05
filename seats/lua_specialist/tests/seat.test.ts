import { join } from 'node:path'
import { expect, test } from 'vitest'
import { packs } from '../../../reviews/packs.ts'
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
  mode: 'build',
})

test('the prompt says every test run is in the foreground', () => {
  expect(seat(root, 'lua_specialist').prompt).toContain('Every test run is in the foreground; wait for it to finish.')
})

test('D1: the build mode, not the prompt, holds the framing', () => {
  const { prompt } = seat(root, 'lua_specialist')
  for (const text of ['You build', '- id: D1', 'A file the ask needs removed goes under `## Deleted`']) {
    expect(prompt).not.toContain(text)
  }
})

test('D1: What to check opens the prompt with the Lua checks', () => {
  const { prompt } = seat(root, 'lua_specialist')
  expect(prompt.startsWith('# lua_specialist\n\n## What to check\n')).toBe(true)
  const checks = prompt.slice(0, prompt.indexOf('## Profile'))
  for (const word of ['reference implementation', 'luacheck']) expect(checks).toContain(word)
})

test('D2: review mode reads What to check before the profile', () => {
  const p = 'lua/pay.lua'
  const out = packs(root, `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new\n`, null)
  const at = out.indexOf('## What to check')
  expect(at).toBeGreaterThan(-1)
  expect(at).toBeLessThan(out.indexOf('## Profile'))
})
