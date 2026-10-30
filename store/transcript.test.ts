import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../checks/sqlite.ts'
import { planRow } from '../runner/index.ts'
import { load } from '../runner/rules.ts'
import type { Db } from './index.ts'
import { backfill, models, outputs, spawned, unfinished } from './transcript.ts'

const root = join(import.meta.dirname, '..')
const loaded = (): Db => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  return db
}
const fixture = (name: string): string => join(import.meta.dirname, 'fixtures', `${name}.transcript.jsonl`)

function run(db: Db, transcript: string, spent: number | null): number {
  const row = db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens, output_tokens, seconds, exit, transcript_path, cost_usd)
    VALUES (?, 2, 'typescript_specialist', ?, 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, ?, ?)`)
    .run(planRow(db), 'a'.repeat(64), transcript, spent)
  return Number(row.lastInsertRowid)
}

const spent = (db: Db, id: number): unknown => (db.prepare('SELECT cost_usd FROM runs WHERE id = ?').get(id) as { cost_usd: unknown }).cost_usd

test('backfill fills NULL costs once and never overwrites', () => {
  const db = loaded()
  const empty = run(db, fixture('costed'), null)
  const set = run(db, fixture('costed'), 2.96)
  expect(backfill(db)).toBe(1)
  expect(spent(db, empty)).toBe(0.43)
  expect(spent(db, set)).toBe(2.96)
  expect(backfill(db)).toBe(0)
  expect([spent(db, empty), spent(db, set)]).toEqual([0.43, 2.96])
})

test('D1 unfinished names the Bash command put in the background', () => {
  expect(unfinished(fixture('unfinished'))).toBe('npm test')
})

test('D3 null for a missing file, no moved result, no Bash match', () => {
  const unmatched = join(mkdtempSync(join(tmpdir(), 'cf-transcript-')), 'unmatched.transcript.jsonl')
  writeFileSync(unmatched, readFileSync(fixture('unfinished'), 'utf8').replace('"tool_use_id":"toolu_1"', '"tool_use_id":"toolu_2"'))
  expect([unfinished(fixture('absent')), unfinished(fixture('costed')), unfinished(unmatched)]).toEqual([null, null, null])
})

const PREVIEW = '<persisted-output>\nOutput too large (27.3KB). Full output saved to: /tmp/x\n\nPreview (first 2KB):\nfirst line\n...\n</persisted-output>'

function transcript(content: string, saved?: object): string {
  const path = join(mkdtempSync(join(tmpdir(), 'cf-transcript-')), 'run.transcript.jsonl')
  const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'node run.js' } }] } }
  const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] }, tool_use_result: saved }
  writeFileSync(path, [call, result].map((line) => JSON.stringify(line)).join('\n'))
  return path
}

test('a preview gives the full output saved at its path', () => {
  const saved = join(mkdtempSync(join(tmpdir(), 'cf-persisted-')), 'toolu_1.txt')
  writeFileSync(saved, `${'x'.repeat(4096)}\nquote past the preview\n`)
  const output = outputs(transcript(PREVIEW, { stdout: 'first line', persistedOutputPath: saved }))[0]?.output
  expect(output).toContain('quote past the preview')
})

test('D1 a preview with no saved path reads the file it names', () => {
  const named = join(mkdtempSync(join(tmpdir(), 'cf-persisted-')), 'toolu_1.txt')
  writeFileSync(named, `${'x'.repeat(4096)}\nquote past the preview\n`)
  const output = outputs(transcript(PREVIEW.replace('/tmp/x', named), { stdout: 'first line' }))[0]?.output
  expect(output).toContain('quote past the preview')
})

test('D2 persistedOutputPath wins over the path in the preview', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-persisted-'))
  writeFileSync(join(dir, 'a.txt'), 'from A')
  writeFileSync(join(dir, 'b.txt'), 'from B')
  const path = transcript(PREVIEW.replace('/tmp/x', join(dir, 'a.txt')), { persistedOutputPath: join(dir, 'b.txt') })
  expect(outputs(path)[0]?.output).toBe('from B')
})

test('a preview with no saved path gives its stdout', () => {
  expect(outputs(fixture('persisted'))).toEqual([{ command: 'node run.js', output: 'first line\nlast line' }])
})

test('a plain result or a bare preview keeps its own text', () => {
  expect(outputs(transcript('out\nerr: warn', { stdout: 'out' }))[0]?.output).toBe('out\nerr: warn')
  expect(outputs(transcript(PREVIEW))[0]?.output).toBe(PREVIEW)
})

const spawn = { type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { description: 'd', prompt: 'p', subagent_type: 'general-purpose' } }

function lines(...turns: unknown[][]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'cf-transcript-')), 'run.transcript.jsonl')
  writeFileSync(path, turns.map((content) => JSON.stringify({ type: 'assistant', message: { content } })).join('\n'))
  return path
}

test('D2 spawned counts Agent blocks, not Read or Bash', () => {
  const read = { type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: 'a' } }
  const bash = { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'pwd' } }
  expect(spawned(lines(Array(5).fill(spawn), [read, spawn, bash], [spawn, spawn]))).toBe(8)
})

test('D3 spawned is 0 for a missing or non-JSON transcript', () => {
  const broken = lines([spawn])
  writeFileSync(broken, `${readFileSync(broken, 'utf8')}\nnot json`)
  expect([spawned(fixture('absent')), spawned(broken)]).toEqual([0, 0])
})

test('a directory path throws EISDIR rather than reading empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-transcript-'))
  expect(() => spawned(dir)).toThrow(/EISDIR/)
  expect(() => outputs(dir)).toThrow(/EISDIR/)
})

test('D2 models reads the result line modelUsage', () => {
  expect(models(fixture('priced'))).toEqual({
    'claude-opus-5-5': { inputTokens: 15177, outputTokens: 1234, cacheReadInputTokens: 2139, cacheCreationInputTokens: 20089 },
    'claude-sonnet-5': { inputTokens: 402, outputTokens: 418656, cacheReadInputTokens: 29640196, cacheCreationInputTokens: 1480800 },
  })
})

test('D2 models is null: missing, no result, cut line, {}', () => {
  const text = readFileSync(fixture('priced'), 'utf8')
  const cut = join(mkdtempSync(join(tmpdir(), 'cf-transcript-')), 'cut.transcript.jsonl')
  writeFileSync(cut, text.slice(0, -40))
  const empty = join(mkdtempSync(join(tmpdir(), 'cf-transcript-')), 'empty.transcript.jsonl')
  writeFileSync(empty, text.replace(/"modelUsage":.*\}\}\}/, '"modelUsage":{}}'))
  expect([models(fixture('absent')), models(lines([spawn])), models(cut), models(empty)]).toEqual([null, null, null, null])
})

test('a missing, uncosted or cut transcript stays NULL', () => {
  const db = loaded()
  const missing = run(db, fixture('absent'), null)
  const uncosted = run(db, fixture('uncosted'), null)
  expect(backfill(db)).toBe(0)
  expect([spent(db, missing), spent(db, uncosted)]).toEqual([null, null])
})
