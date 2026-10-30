import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Read } from '../../cli/gh.ts'
import { mirrored } from '../greptile-mirror.ts'

const BOT = 'greptile-apps[bot]'

const HEAD = '# Review rules for acme/kit, from its own Greptile reviews'

function badged(n: number, title: string, text: string, topics: string[] = []): string {
  const kb = topics.length === 0 ? [] : ['', `**Knowledge Base Used:** ${topics.map((t) => `[${t}](https://app.greptile.com/kb/${t}.md)`).join(', ')}`]
  return [`<a href="#"><img alt="P${String(n)}" src="https://greptile-static-assets.s3.amazonaws.com/badges/p${String(n)}.svg?v=9" align="top"></a> **${title}**`,
    '', text, ...kb].join('\n')
}

const line = (body: string, login = BOT): object =>
  ({ id: 1, commit_id: 'a', original_commit_id: 'a', path: 'SolanaSigner.kt', line: 108, original_line: 108, body, user: { login } })

function reader(bodies: object[], calls: string[][] = [], checks: string[] = []): Read {
  return (args) => {
    calls.push(args)
    return args[0] === 'pr' ? [{ number: 336, statusCheckRollup: checks.map((name) => ({ name })) }] : bodies
  }
}

const temp = (): string => mkdtempSync(join(tmpdir(), 'cf-mirror-'))

function mirror(bodies: object[], repo = 'acme/kit', dir = temp()): Record<string, string> | null {
  return mirrored(temp(), repo, dir, reader(bodies))
}

const rulesOf = (bodies: object[], dir?: string): string | undefined => mirror(bodies, 'acme/kit', dir)?.['.greptile/rules.md']

function strictness(badges: number[]): unknown {
  const read = reader(badges.map((n) => line(badged(n, `t${String(n)}`, 'x'))), [], ['Greptile Review'])
  return (JSON.parse(mirrored(temp(), 'acme/kit', temp(), read)?.['.greptile/config.json'] ?? '') as { strictness: number }).strictness
}

test('D1 knowledge-base topics become sorted sections', () => {
  expect(rulesOf([
    line(badged(2, 'Extra signatures look complete', 'A tail of empty slots\nreads as signed.', ['Go core signing primitives'])),
    line(badged(1, 'Parity tests miss Kotlin', 'No vector runs here.', ['Cross-language parity and integration testing'])),
  ])).toBe(`${HEAD}\n\n## Cross-language parity and integration testing\n\n- Parity tests miss Kotlin (P1, 1×): No vector runs here.\n\n`
    + '## Go core signing primitives\n\n- Extra signatures look complete (P2, 1×): A tail of empty slots reads as signed.\n')
})

test('D2 same title with no topic folds into one row', () => {
  const body = line(badged(2, 'Invalid lengths get signed', 'compact-u16 is not checked.'))
  expect(rulesOf([body, body])).toBe(`${HEAD}\n\n## Other findings\n\n- Invalid lengths get signed (P2, 2×): compact-u16 is not checked.\n`)
})

test('D3 unbadged replies and other authors give no row', () => {
  expect(rulesOf([line("You're right—I'm withdrawing the finding"), line(badged(1, 'Mine', 'x'), 'someone')])).toBe(`${HEAD}\n`)
})

test('D4 no Greptile check and no bot comment: null', () => {
  expect(mirror([line(badged(1, 'Mine', 'x'), 'someone')])).toBeNull()
  expect(mirrored(temp(), 'acme/kit', temp(), reader([], [], ['Greptile Review']))).not.toBeNull()
})

test('D5 strictness follows the least severe badge', () => {
  expect([strictness([1, 2]), strictness([1]), strictness([1, 3]), strictness([])]).toEqual([2, 3, 1, 2])
})

test('D6 a harvest is read back for 7 days, then rerun', () => {
  const root = temp()
  const calls: string[][] = []
  const read = reader([line(badged(2, 'Once', 'x'))], calls)
  const t = Date.parse('2026-10-01T00:00:00Z')
  const first = mirrored(root, 'acme/kit', temp(), read, new Date(t))
  const made = calls.length
  expect(mirrored(root, 'acme/kit', temp(), read, new Date(t + 7 * 86_400_000 - 1))).toEqual(first)
  expect(calls.length).toBe(made)
  mirrored(root, 'acme/kit', temp(), read, new Date(t + 7 * 86_400_000))
  expect(calls.length).toBe(2 * made)
})

test('D7 CONTRIBUTING and the PR template are carried when present', () => {
  const dir = temp()
  mkdirSync(join(dir, '.github'))
  writeFileSync(join(dir, 'CONTRIBUTING.md'), 'Be kind.\n')
  writeFileSync(join(dir, '.github/pull_request_template.md'), '## Summary\n')
  expect(rulesOf([line('reply')], dir)).toBe(`${HEAD}\n\n## Contributing\n\nBe kind.\n\n## Pull request template\n\n## Summary\n`)
  expect(rulesOf([line('reply')])).toBe(`${HEAD}\n`)
})

test('D9 solana-keychain config lists its three profile files', () => {
  const root = temp()
  cpSync(join(import.meta.dirname, '../../profiles/solana-foundation'), join(root, 'profiles/solana-foundation'), { recursive: true })
  const config = mirrored(root, 'solana-foundation/solana-keychain', temp(), reader([line('reply')]))?.['.greptile/config.json'] ?? ''
  expect(JSON.parse(config)).toEqual({ autoReview: [], strictness: 2, customContext: { files: [
    { path: 'go/core/txutil.go', scope: ['**'] },
    { path: 'rust/src/transaction_util.rs', scope: ['**'] },
    { path: 'python/src/solana_keychain/core/transaction_util.py', scope: ['**'] },
  ] } })
})
