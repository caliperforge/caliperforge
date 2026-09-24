import { languageSeat } from '../../../runner/tests/language-seat.ts'

languageSeat({
  seat: 'lua_specialist',
  language: 'lua',
  commands: ['Bash(just:*)', 'Bash(luajit:*)', 'Bash(luacheck:*)', 'Bash(busted:*)'],
  allowed: ['just --justfile lua/Justfile test', 'just --justfile lua/Justfile lint', 'luacheck lua/pay_kit', 'luajit tests/run.lua'],
  listed: 'lua/pay_kit/internal/config.lua',
  beside: 'ruby/lib/pay_kit/config.rb',
})
