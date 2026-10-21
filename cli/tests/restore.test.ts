import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { restore } from '../restore.ts'

const ANSWER = 'The answer — sourced.\n'
const SOURCES = '[{"url": "https://example.com"}]\n'

const write = (path: string, content: string): object => ({ type: 'tool_use', name: 'Write', input: { file_path: path, content } })

function rooted(blocks: object[]): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-restore-'))
  const dir = join(root, '.cf/work/1511')
  mkdirSync(dir, { recursive: true })
  const bash = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }
  const lines = [bash, { type: 'assistant', message: { content: blocks } }].map((l) => JSON.stringify(l))
  writeFileSync(join(dir, 'run-1.transcript.jsonl'), `${lines.join('\n')}\nnot json\n`)
  writeFileSync(join(dir, 'answer.md'), 'stub')
  return root
}

test('D1 restores answer.md and sources.json as written', () => {
  const root = rooted([write('/x/answer.md', 'old'), write('/x/answer.md', ANSWER), write('/x/sources.json', SOURCES),
    write('/x/other.md', 'other')])
  const dir = join(root, '.cf/work/1511')
  expect(restore(root, 1511, 'run-1.transcript.jsonl:2')).toEqual([join(dir, 'answer.md'), join(dir, 'sources.json')])
  expect(readFileSync(join(dir, 'answer.md'), 'utf8')).toBe(ANSWER)
  expect(readFileSync(join(dir, 'sources.json'), 'utf8')).toBe(SOURCES)
  expect(existsSync(join(dir, 'other.md'))).toBe(false)
})

test('D2 a line without sources.json writes nothing', () => {
  const root = rooted([write('/x/answer.md', ANSWER)])
  const dir = join(root, '.cf/work/1511')
  expect(() => restore(root, 1511, 'run-1.transcript.jsonl:2')).toThrow('sources.json')
  expect(readFileSync(join(dir, 'answer.md'), 'utf8')).toBe('stub')
  expect(existsSync(join(dir, 'sources.json'))).toBe(false)
})

test.each(['run-1.transcript.jsonl', 'run-1.transcript.jsonl:9', 'run-1.transcript.jsonl:3', 'run-1.transcript.jsonl:1'])(
  'D3 %s throws and writes nothing', (at) => {
    const root = rooted([write('/x/answer.md', ANSWER), write('/x/sources.json', SOURCES)])
    const dir = join(root, '.cf/work/1511')
    expect(() => restore(root, 1511, at)).toThrow()
    expect(readFileSync(join(dir, 'answer.md'), 'utf8')).toBe('stub')
    expect(existsSync(join(dir, 'sources.json'))).toBe(false)
  })
