import { join } from 'node:path'
import { expect, test } from 'vitest'
import { packs } from '../../../reviews/packs.ts'
import { seat } from '../../../runner/rules.ts'
import { languageSeat } from '../../../runner/tests/language-seat.ts'

languageSeat({
  seat: 'rust_specialist',
  language: 'rust',
  commands: ['Bash(cargo test:*)', 'Bash(cargo check:*)', 'Bash(cargo build:*)', 'Bash(cargo clippy:*)', 'Bash(cargo fmt:*)', 'Bash(cargo +nightly fmt:*)'],
  allowed: ['cargo test -p surfpool-core', 'cargo +nightly fmt --all -- --check', 'cargo fmt --manifest-path rust/Cargo.toml --all -- --check', 'cargo clippy -p surfpool-core --all-targets'],
  listed: 'crates/core/src/rpc/surfnet_cheatcodes.rs',
  beside: 'crates/cli/src/main.rs',
  mode: 'build',
})

test('a generated file matches its generator, not a byte format', () => {
  const prompt = seat(join(import.meta.dirname, '../../..'), 'rust_specialist').prompt.replace(/\s+/g, ' ')
  expect(prompt).toContain('match what the generator the brief names writes: step 3 runs that generator and fails on any diff.')
  expect(prompt).not.toContain('header, field order, quoting and trailing newline')
})

test('the prompt says every command runs in the foreground', () => {
  expect(seat(join(import.meta.dirname, '../../..'), 'rust_specialist').prompt).toContain(
    'Every command runs in the foreground; wait for it to finish, and answer only after it has.',
  )
})

test('D1: What to check opens the prompt with the Rust checks', () => {
  const { prompt } = seat(join(import.meta.dirname, '../../..'), 'rust_specialist')
  expect(prompt.startsWith('# rust_specialist\n\n## What to check\n')).toBe(true)
  const checks = prompt.slice(0, prompt.indexOf('## Profile'))
  for (const word of ['reference implementation', 'clippy', 'cargo fmt', 'generator']) expect(checks).toContain(word)
})

test('D2: review mode reads What to check before the profile', () => {
  const p = 'crates/core/src/lib.rs'
  const out = packs(join(import.meta.dirname, '../../..'), `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new\n`, null)
  const at = out.indexOf('## What to check')
  expect(at).toBeGreaterThan(-1)
  expect(at).toBeLessThan(out.indexOf('## Profile'))
})
