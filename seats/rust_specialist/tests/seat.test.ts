import { join } from 'node:path'
import { expect, test } from 'vitest'
import { seat } from '../../../runner/rules.ts'
import { languageSeat } from '../../../runner/tests/language-seat.ts'

languageSeat({
  seat: 'rust_specialist',
  language: 'rust',
  commands: ['Bash(cargo test:*)', 'Bash(cargo check:*)', 'Bash(cargo build:*)', 'Bash(cargo clippy:*)', 'Bash(cargo fmt:*)', 'Bash(cargo +nightly fmt:*)'],
  allowed: ['cargo test -p surfpool-core', 'cargo +nightly fmt --all -- --check', 'cargo fmt --manifest-path rust/Cargo.toml --all -- --check', 'cargo clippy -p surfpool-core --all-targets'],
  listed: 'crates/core/src/rpc/surfnet_cheatcodes.rs',
  beside: 'crates/cli/src/main.rs',
})

test('a generated file matches the generator the brief names, not a described byte format', () => {
  const prompt = seat(join(import.meta.dirname, '../../..'), 'rust_specialist').prompt.replace(/\s+/g, ' ')
  expect(prompt).toContain('match what the generator the brief names writes: step 3 runs that generator and fails on any diff.')
  expect(prompt).not.toContain('header, field order, quoting and trailing newline')
})
