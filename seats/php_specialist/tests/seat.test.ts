import { join } from 'node:path'
import { expect, test } from 'vitest'
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
})

test('the prompt says every test run is in the foreground', () => {
  expect(seat(root, 'php_specialist').prompt).toContain('Every test run is in the foreground; wait for it to finish.')
})
