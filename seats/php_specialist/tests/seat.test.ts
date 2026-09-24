import { languageSeat } from '../../../runner/tests/language-seat.ts'

languageSeat({
  seat: 'php_specialist',
  language: 'php',
  commands: ['Bash(composer:*)', 'Bash(php -l:*)', 'Bash(just:*)'],
  allowed: ['composer -d php test', 'composer -d php run lint', 'just --justfile php/Justfile test', 'php -l php/src/Config.php'],
  listed: 'php/src/Config.php',
  beside: 'go/config.go',
})
