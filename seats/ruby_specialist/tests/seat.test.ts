import { languageSeat } from '../../../runner/tests/language-seat.ts'

languageSeat({
  seat: 'ruby_specialist',
  language: 'ruby',
  commands: ['Bash(just:*)', 'Bash(bundle install:*)', 'Bash(bundle exec:*)'],
  allowed: ['just --justfile ruby/Justfile test', 'just --justfile ruby/Justfile lint', 'bundle exec standardrb', 'bundle install'],
  listed: 'ruby/lib/pay_kit/config.rb',
  beside: 'python/src/solana_pay_kit/config.py',
})
