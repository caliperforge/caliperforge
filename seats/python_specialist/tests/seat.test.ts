import { languageSeat } from '../../../runner/tests/language-seat.ts'

languageSeat({
  seat: 'python_specialist',
  language: 'python',
  commands: ['Bash(uv run:*)', 'Bash(uv sync:*)', 'Bash(just:*)'],
  allowed: ['just --justfile python/Justfile test', 'uv run --directory python pytest', 'uv run --directory python ruff check', 'uv sync --directory python --extra dev'],
  listed: 'python/src/solana_pay_kit/config.py',
  beside: 'ruby/lib/pay_kit/config.rb',
})
