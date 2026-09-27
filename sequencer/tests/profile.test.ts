import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { profile } from '../../store/profile.ts'
import { gates, type OutsideLanguage } from '../gates.ts'
import { messageOf, prBody } from '../push.ts'
import { checkout, put, srcDir } from '../workspace.ts'
import { world } from './world.ts'

const REPO = join(import.meta.dirname, '../..')

function nested(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-profile-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  return dir
}

const just = (...names: string[]): string => names.map((n) => `${n}:\n    echo ${n}\n`).join('\n')

const PAY_KIT = nested({
  'python/Justfile': just('install', 'lint', 'typecheck', 'test'), 'python/pyproject.toml': '',
  'ruby/Justfile': just('install', 'test', 'fmt', 'lint'), 'ruby/Gemfile': '',
  'php/Justfile': just('install', 'test', 'lint'), 'php/composer.json': '',
  'lua/Justfile': just('install', 'test', 'lint'), 'lua/pay-kit-dev-1.rockspec': '',
  'go/Justfile': just('test', 'lint'), 'go/go.mod': 'module x\n',
  'rust/Cargo.toml': '[workspace]\n', 'rust/crates/kit/Cargo.toml': '[package]\nname = "pay-kit"\n',
})

const SURFPOOL = nested({
  'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
  'crates/core/Cargo.toml': '[package]\nname = "surfpool-core"\n\n[features]\npostgres = []\nignore_tests_ci = []\n',
  '.github/workflows/rust.yml': 'jobs:\n  fmt:\n    services:\n      postgres:\n        image: postgres:15\n'
    + '    steps:\n      - run: cargo +nightly fmt --all -- --check\n'
    + '      - run: cargo test --all --features "postgres,ignore_tests_ci"\n',
  '.github/workflows/sdk.yml': 'jobs:\n  bindings:\n    steps:\n      - run: |\n'
    + '          node crates/sdk-node/scripts/generate-kit-types.js\n          git diff --exit-code\n',
})

const justGates = (dir: string, ...names: string[]): object[] =>
  names.map((script) => ({ script, bin: 'just', args: ['--justfile', 'Justfile', script], dir }))

const CASES: { src: string; repo: string; language: OutsideLanguage; file: string; gates: object[] }[] = [
  { src: PAY_KIT, repo: 'pay-kit', language: 'python', file: 'python/src/pay_kit/memo.py', gates: justGates('python', 'install', 'lint', 'typecheck', 'test') },
  { src: PAY_KIT, repo: 'pay-kit', language: 'ruby', file: 'ruby/lib/pay_kit/memo.rb', gates: justGates('ruby', 'install', 'lint', 'test') },
  { src: PAY_KIT, repo: 'pay-kit', language: 'php', file: 'php/src/Memo.php', gates: justGates('php', 'install', 'lint', 'test') },
  { src: PAY_KIT, repo: 'pay-kit', language: 'lua', file: 'lua/pay_kit/memo.lua', gates: justGates('lua', 'install', 'lint', 'test') },
  { src: PAY_KIT, repo: 'pay-kit', language: 'go', file: 'go/memo.go', gates: justGates('go', 'lint', 'test') },
  { src: PAY_KIT, repo: 'pay-kit', language: 'rust', file: 'rust/crates/kit/src/lib.rs', gates: [
    { script: 'format', bin: 'cargo', args: ['fmt', '--all', '--', '--check'], dir: 'rust' },
    { script: 'test', bin: 'cargo', args: ['test', '-p', 'pay-kit'], dir: 'rust' },
  ] },
  { src: SURFPOOL, repo: 'surfpool', language: 'rust', file: 'crates/core/src/rpc/a.rs', gates: [
    { script: 'format', bin: 'cargo', args: ['+nightly', 'fmt', '--all', '--', '--check'], dir: '' },
    { script: 'test', bin: 'cargo', args: ['test', '-p', 'surfpool-core', '--features', 'surfpool-core/ignore_tests_ci'], dir: '' },
    { script: 'stage', bin: 'git', args: ['add', '-A'], dir: '' },
    { script: 'generate', bin: 'node', args: ['crates/sdk-node/scripts/generate-kit-types.js'], dir: '' },
    { script: 'diff', bin: 'git', args: ['diff', '--exit-code'], dir: '' },
  ] },
]

test.each(CASES)('D4 D5 $repo $language gates are pinned and follow its profile checks', (c) => {
  const found = gates(c.src, { language: c.language, files: [c.file] })
  expect(found).toEqual(c.gates)
  expect(found.map((g) => g.script)).toEqual(profile(REPO, `solana-foundation/${c.repo}`)?.checks?.[c.language])
})

const BRIEFS = [
  {
    issue: '# feat(python): carry a memo (#35)\n\n**What:** Add a memo field to the payment request.\n**Why:** #35 asks for it.\n',
    message: 'feat(python): carry a memo ()\n\nAdd a memo field to the payment request.\n\nasks for it.',
    body: ['Addresses #12.', '', '## Summary', '', '- Add a memo field to the payment request.', '- #35 asks for it.', '',
      '## Test Plan', '', '- `src/hello.test.ts`', '- CI green on our fork at this head.', ''].join('\n'),
  },
  {
    issue: '# fix(rpc): surfnet_getAccount returns the owner\n\n**What:** Return the account owner.\n**Why:** Callers read it.\n',
    message: 'fix(rpc): surfnet_getAccount returns the owner\n\nReturn the account owner.\n\nCallers read it.',
    body: ['Addresses #12.', '', '## Summary', '', '- Return the account owner.', '- Callers read it.', '',
      '## Test Plan', '', '- `src/hello.test.ts`', '- CI green on our fork at this head.', ''].join('\n'),
  },
]

test.each(BRIEFS)('D5 the outside commit message and PR body are pinned: $message', (b) => {
  const w = world()
  checkout(w.root, 1, 'acme/widget', 'widget-12-a1')
  writeFileSync(join(srcDir(w.root, 1), 'src/hello.test.ts'), 'export {}\n')
  put(w.root, 1, 'issue.md', b.issue)
  expect(messageOf(w.root, 1)).toBe(b.message)
  expect(prBody(12, w.root, 1)).toBe(b.body)
})

const MCP = nested({
  'profiles/modelcontextprotocol/_org.yml': 'disclosure: This change was written with AI assistance.\ntrailer: "Co-Authored-By: Claude"\n',
  'profiles/modelcontextprotocol/go-sdk.yml': 'subject: package\nissue_ref: Fixes\nai_trailer: true\n',
})

function memo(): string {
  const w = world()
  checkout(w.root, 1, 'acme/widget', 'widget-35-a1')
  put(w.root, 1, 'issue.md', '# feat(mcp): Add a memo\n\n**What:** Carry a memo.\n**Why:** Fixes #35.\n')
  return w.root
}

test('D4 a go-sdk profile shapes the subject, keeps Fixes #N and adds the trailer and disclosure', () => {
  const root = memo()
  const rules = profile(MCP, 'modelcontextprotocol/go-sdk')
  expect(messageOf(root, 1, rules)).toBe('mcp: add a memo\n\nCarry a memo.\n\nFixes #35.\n\nCo-Authored-By: Claude')
  expect(prBody(35, root, 1, rules)).toMatch(/- CI green on our fork at this head\.\n\nThis change was written with AI assistance\.\n$/)
})

test.each([{ ai_trailer: false, trailer: 'Co-Authored-By: Claude' }, { ai_trailer: true }, null])(
  'D5 no Co-Authored-By line under %o', (rules) => {
    expect(messageOf(memo(), 1, rules)).not.toContain('Co-Authored-By')
  })
