import { languageSeat } from '../../../runner/tests/language-seat.ts'

languageSeat({
  seat: 'rust_specialist',
  language: 'rust',
  commands: ['Bash(cargo test:*)', 'Bash(cargo check:*)', 'Bash(cargo build:*)', 'Bash(cargo clippy:*)', 'Bash(cargo fmt:*)', 'Bash(cargo +nightly fmt:*)'],
  allowed: ['cargo test -p surfpool-core', 'cargo +nightly fmt --all -- --check', 'cargo fmt --manifest-path rust/Cargo.toml --all -- --check', 'cargo clippy -p surfpool-core --all-targets'],
  listed: 'crates/core/src/rpc/surfnet_cheatcodes.rs',
  beside: 'crates/cli/src/main.rs',
})
