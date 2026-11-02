import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Seat, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')
const ROW = '- area: <file or file:function> | decision: <one line> | why: <one line, quoting the thread where possible> | said_by: <login> (<maintainer|contributor>) | source: <comment URL>'
const OPENING = "- opening: <deferred|asked> | area: <file or file:function> | quote: <the maintainer's words> | said_by: <login> | source: <comment URL>"

test('D1: the manifest is Sonnet with no tools and no write path', () => {
  expect(seat(root, 'precedent_writer').manifest).toEqual({ seat: 'precedent_writer', model: 'claude-sonnet-5', effort: 'medium', tools: [], write_paths: [] })
})

test('D2: the roster carries precedent_writer as a rules row', () => {
  expect(rules(root)).toContainEqual(expect.objectContaining({ id: 'precedent_writer', kind: 'card', path: 'rules/roster/precedent_writer.yaml' }))
})

test('D3: the prompt holds the row line and its roles', () => {
  const prompt = seat(root, 'precedent_writer').prompt
  for (const part of [ROW, OPENING, '`none`', 'maintainer', 'contributor']) expect(prompt).toContain(part)
})

test('D4: a write tool with no write paths is still refused', () => {
  const manifest = seat(root, 'precedent_writer').manifest
  expect(() => Seat.parse({ ...manifest, tools: ['Write'] })).toThrow(/save Bash\(cf look:\*\)/)
})
