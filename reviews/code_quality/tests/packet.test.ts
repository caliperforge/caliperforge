import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { expect, test } from 'vitest'
import { gate } from '../../../providers/claude-agent-sdk/index.ts'
import { Review, admits, benchPacket, reviewManifest, spec } from '../../../runner/packet.ts'
import { tight } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')
const TRANSCRIPT = join(tmpdir(), 'cf-review.transcript.jsonl')
const repo = '/tmp/cf-review'

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '../fixtures', name), 'utf8')
}

function bench(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { repo, issue: fixture('issue.md'), diff: fixture('seeded.diff'), ...over }
}

function built(input: unknown): { packet: { prompt: string; cwd: string; tools: string[]; refuse: (p: string) => unknown } } {
  const out = benchPacket(root, 'code_quality', input, TRANSCRIPT)
  if ('refusal' in out) throw new Error(`refused: ${out.refusal.origin_ref}`)
  return out
}

test('the packet is the repo, the issue, the diff and the Tight spec and nothing else', () => {
  const { packet } = built(bench())
  const issue = fixture('issue.md')
  const diff = fixture('seeded.diff')
  expect(packet.prompt).toBe(`${tight(root)}\n\n${spec(root, 'code_quality')}\n\n# Issue\n\n${issue}\n\n# Diff\n\n${diff}`)
  expect(packet.cwd).toBe(repo)
})

test('a ticket path and a crypto-contributor path are refused with an origin', () => {
  for (const path of [
    '/Users/michael/Documents/Claude/Projects/crypto-contributor',
    '/Users/michael/cf_v2/agents/coo/inbox/T-COO-V2-P4B-REVIEW-BENCH-2026-09-17.md',
    'knowledge/gate_authority_standard.md',
    'ops/decisions.md',
  ]) {
    expect(admits(path)).toMatchObject({ origin_kind: 'ruling', origin_ref: 'reviewers.maintainers_view' })
    expect(benchPacket(root, 'code_quality', bench({ repo: path }), TRANSCRIPT)).toMatchObject({ refusal: { path } })
  }
  expect(admits(repo)).toBeNull()
})

test('a fifth source is refused, and the first verdict only where the manifest reads one', () => {
  expect(benchPacket(root, 'code_quality', bench({ ticket: 'T-X' }), TRANSCRIPT)).toMatchObject({ refusal: { path: 'ticket' } })
  expect(benchPacket(root, 'code_quality', bench({ card: 'agents/coo/CARD.md' }), TRANSCRIPT)).toMatchObject({ refusal: { path: 'card' } })
  expect(benchPacket(root, 'code_quality', bench({ verdict: 'refuse' }), TRANSCRIPT)).toMatchObject({ refusal: { path: 'verdict' } })
  expect(benchPacket(root, 'senior_review', bench(), TRANSCRIPT)).toMatchObject({ refusal: { path: 'verdict' } })
  expect(benchPacket(root, 'code_quality', bench({ since: '+ a line since' }), TRANSCRIPT)).toMatchObject({ refusal: { path: 'since' } })
})

const BLOB = 'a'.repeat(40)

test('a re-review packet carries the last verdict, the diff since it, then git on what did not move', () => {
  const out = benchPacket(root, 'senior_review', bench({
    verdict: 'the first verdict', prior: 'my last verdict', since: '+ a line since',
    narrowing: { changed: ['src/stats.ts'], merged: ['src/main.ts'], unchanged: [['src/parse.ts', BLOB]] },
  }), TRANSCRIPT)
  if ('refusal' in out) throw new Error(`refused: ${out.refusal.path}`)
  const prompt = out.packet.prompt
  expect(prompt.indexOf('# First verdict')).toBeLessThan(prompt.indexOf('# Your last verdict'))
  expect(prompt).toContain('\n\n# Your last verdict\n\nmy last verdict\n\n# Changed since your last verdict\n\n+ a line since')
  expect(prompt.endsWith('\n\n# Paths since your last verdict\n\nchanged since the tree you judged:\n  - src/stats.ts\n\n'
    + "merged from main, not the builder's:\n  - src/main.ts\n\n"
    + `unchanged since you judged it, at the blob it had then:\n  - src/parse.ts ${BLOB}`)).toBe(true)
})

test('the reviewer manifest declares no write path, and holds no write or browse tool', () => {
  const manifest = reviewManifest(root, 'code_quality')
  expect(manifest.write_paths).toEqual([])
  expect(manifest.tools).toEqual(['Read'])
  for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Bash', 'MultiEdit', 'Glob', 'Grep']) {
    expect(Review.safeParse({ ...manifest, tools: [tool] }).success).toBe(false)
    expect(Review.safeParse({ ...manifest, tools: ['Read', tool] }).success).toBe(false)
  }
  expect(Review.safeParse({ ...manifest, write_paths: ['src'] }).success).toBe(false)
})

test('the runner refuses every write from the reviewer packet, origin on refuse', () => {
  const { packet } = built(bench())
  for (const path of ['src/stats.ts', `${repo}/src/stats.ts`, '/etc/passwd', '../escape.ts']) {
    expect(packet.refuse(path)).toMatchObject({ origin_kind: 'ruling', origin_ref: 'seat.write_paths' })
  }
})

test('the provider gate denies the reviewer a write and lets a read through', () => {
  const { packet } = built(bench())
  const pre = (tool: string, file: string): HookInput =>
    ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file }, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: repo })
  expect(gate(packet as never, pre('Read', 'src/stats.ts'))).toEqual({ continue: true })
  expect(gate(packet as never, pre('Write', 'src/stats.ts'))).toMatchObject({
    continue: false,
    hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'ruling:seat.write_paths refuses a write to src/stats.ts' },
  })
})
