import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { audit } from '../../../rails/completion-audit/index.ts'
import { Seat, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')

test('the manifest fences writes to the files the brief names', () => {
  expect(Seat.parse(seat(root, 'outside_specialist').manifest)).toMatchObject({
    seat: 'outside_specialist',
    write_paths: ['brief:files'],
  })
})

test('it holds no shell', () => {
  expect(seat(root, 'outside_specialist').manifest.tools.some((t) => t.startsWith('Bash'))).toBe(false)
})

test('the roster carries the seat', () => {
  expect(rules(root).find((r) => r.id === 'outside_specialist')).toMatchObject({ kind: 'card' })
})

test('minimal-edit rule in every builder, the brief and the first review', () => {
  for (const name of ['outside_specialist', 'typescript_specialist', 'kotlin_specialist']) {
    expect(seat(root, name).prompt.replace(/\s+/g, ' ')).toContain('change the value and keep every other word')
  }
  expect(seat(root, 'brief_writer').prompt.replace(/\s+/g, ' ')).toContain('changes that value and no other word')
  expect(readFileSync(join(root, 'reviews/code_quality/spec.md'), 'utf8').replace(/\s+/g, ' '))
    .toContain('rewords a comment, renames or reformats past what the ask needs is a scope finding')
})

test('the prompt says the brief\'s files are handed', () => {
  expect(seat(root, 'outside_specialist').prompt).toContain('follow it under `# The files`')
})

test('the fence asks for a summary above done, and the audit still reads it', () => {
  for (const name of ['go_specialist', 'kotlin_specialist', 'outside_specialist', 'swift_specialist', 'typescript_specialist']) {
    expect(seat(root, name).prompt).toMatch(/^---\nsummary: <the change in one line>\ndone:$/m)
  }
  const fence = (pointer: string) => `---\nsummary: x\ndone:\n  - id: D1\n    status: done\n${pointer}---\n`
  expect(audit(fence('    pointer: a.ts\n'), ['D1']).outcome).toBe('pass')
  expect(audit(fence(''), ['D1']).outcome).toBe('refuse')
})
