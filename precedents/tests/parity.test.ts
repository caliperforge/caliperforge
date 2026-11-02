import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Read } from '../../cli/gh.ts'
import type { Provider } from '../../providers/kind.ts'
import { ofKind } from '../../store/events.ts'
import { hashes } from '../../store/parity.ts'
import { openings, vouched } from '../openings.ts'
import { parity } from '../parity.ts'

const root = join(import.meta.dirname, '../..')

const repo = 'solana-foundation/solana-keychain'

const contract = {
  'rust/src/traits.rs': 'pub trait SolanaSigner {\n    fn pubkey(&self) -> Pubkey;\n    async fn sign_message(&self, m: &[u8]) -> Result<Signature>;\n}\n',
  'go/core/types.go': 'type SolanaSigner interface {\n\tSignMessage(m []byte) (Signature, error)\n}\n',
  'python/src/solana_keychain/core/signer.py': 'class SolanaSigner:\n    async def sign_message(self, m: bytes) -> Signature: ...\n',
  'typescript/packages/core/src/types.ts': 'export interface SolanaSigner {\n  signMessage(m: Uint8Array): Promise<Signature>\n}\n',
}

function reads(files: typeof contract = contract, asked: string[] = []): Read {
  return (args) => {
    const path = (args[1] ?? '').replace(`repos/${repo}/contents/`, '')
    asked.push(path)
    const text = files[path as keyof typeof contract]
    return { size: text.length, content: Buffer.from(text).toString('base64').replace(/(.{60})/g, '$1\n') }
  }
}

function replies(text: string, fired: string[] = [], ended: 'completed' | 'stopped' = 'completed'): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (p) => {
      fired.push(p.prompt)
      return Promise.resolve({ text, transcript_path: p.transcript, usage: { input: 1, cache: 0, output: 1 }, seconds: 0.5, ended, exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
}

const drift = (files: string) => `- drift: sign_message | rust: async fn sign_message | go: func SignMessage | kind: sync-async | files: ${files}`

const both = drift('rust/src/traits.rs:3, go/core/types.go:2')

const refusal = (message: string) => [{ plan: null, kind: 'parity_refused', actor: 'cf', outcome: 'refuse', message }]

it('D1 a sync-async row stores one drift citing both lines', async () => {
  const db = fresh(join(root, 'schema'))
  const fired: string[] = []
  expect(await parity(db, root, repo, replies(both, fired), reads(), '2026-11-01T00:00:00Z')).toBe(1)
  expect(fired[0]).toContain('## rust: rust/src/traits.rs\n\n```\n1 pub trait SolanaSigner {')
  expect(fired[0]).toContain('3     async fn sign_message')
  expect(openings(db, repo)).toEqual([{ repo, kind: 'drift', area: 'sign_message (sync-async)', quote: both.slice('- drift: '.length),
    said_by: 'shape_compare', source: 'rust/src/traits.rs, go/core/types.go', first_seen: '2026-11-01T00:00:00Z' }])
  expect(vouched(db, repo)).toEqual([])
  expect(ofKind(db, 'parity_refused')).toEqual([])
})

it.each([
  { from: 'one citation', line: drift('rust/src/traits.rs:3') },
  { from: "another language's file", line: drift('rust/src/traits.rs:3, python/src/solana_keychain/core/signer.py:2') },
  { from: 'a line past the end', line: drift('rust/src/traits.rs:3, go/core/types.go:4') },
  { from: 'line zero', line: drift('rust/src/traits.rs:0, go/core/types.go:2') },
])('D2 a row with $from is refused', async ({ line }) => {
  const db = fresh(join(root, 'schema'))
  expect(await parity(db, root, repo, replies(line), reads())).toBe(0)
  expect(openings(db, repo)).toEqual([])
  expect(ofKind(db, 'parity_refused')).toEqual(refusal(line))
})

it('D3 a second run on unchanged files fires no seat', async () => {
  const db = fresh(join(root, 'schema'))
  const fired: string[] = []
  expect(await parity(db, root, repo, replies('none', fired), reads())).toBe(0)
  expect(Object.keys(hashes(db, repo))).toHaveLength(4)
  expect(await parity(db, root, repo, replies('none', fired), reads())).toBeNull()
  expect(fired).toHaveLength(1)
})

it('D5 a stopped seat stores no hash and closes no drift', async () => {
  const db = fresh(join(root, 'schema'))
  const fired: string[] = []
  await parity(db, root, repo, replies(both, fired), reads())
  const was = hashes(db, repo)
  const changed = reads({ ...contract, 'go/core/types.go': 'type SolanaSigner interface {\n\tSignMessage(m []byte) <-chan Signature\n}\n' })
  expect(await parity(db, root, repo, replies('none', fired, 'stopped'), changed)).toBe(0)
  expect(hashes(db, repo)).toEqual(was)
  expect(openings(db, repo)).toHaveLength(1)
  expect(ofKind(db, 'parity_refused')).toEqual(refusal('stopped'))
  expect(await parity(db, root, repo, replies(both, fired), changed)).toBe(1)
  expect(fired).toHaveLength(3)
})

it('D6 a repo with no entry throws and reads nothing', async () => {
  const db = fresh(join(root, 'schema'))
  const asked: string[] = []
  const fired: string[] = []
  await expect(parity(db, root, 'o/r', replies('none', fired), reads(contract, asked))).rejects.toThrow('o/r has no entry in precedents/parity.yaml')
  expect([asked, fired]).toEqual([[], []])
})
