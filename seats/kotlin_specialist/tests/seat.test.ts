import { join } from 'node:path'
import { expect, test } from 'vitest'
import { authority } from '../../../rails/authority/index.ts'
import { refuse } from '../../../runner/index.ts'
import { Seat, rules, seat } from '../../../runner/rules.ts'
import { builder } from '../../../templates/pr-path.ts'

const root = join(import.meta.dirname, '../../..')

test('the manifest declares seat, model, effort, tools and write_paths', () => {
  expect(Seat.parse(seat(root, 'kotlin_specialist').manifest)).toMatchObject({
    seat: 'kotlin_specialist',
    effort: 'high',
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    write_paths: ['kotlin'],
  })
})

test('the roster carries the seat and the loader gives it a rules row', () => {
  const row = rules(root).find((r) => r.id === 'kotlin_specialist')
  expect(row).toMatchObject({ kind: 'card', path: 'rules/roster.yaml' })
})

test('the prompt tells the seat to close with the handback fence', () => {
  expect(seat(root, 'kotlin_specialist').prompt).toContain('- id: D1')
})

test('a kotlin tree picks this seat and anything else falls to the default', () => {
  expect(builder('kotlin')).toBe('kotlin_specialist')
  expect(builder(null)).toBe('typescript_specialist')
  expect(builder('cobol')).toBe('typescript_specialist')
})

test('write_paths admit the kotlin module and refuse everything beside it', () => {
  const paths = seat(root, 'kotlin_specialist').manifest.write_paths
  expect(refuse(root, paths, 'kotlin/src/main/kotlin/Types.kt')).toBeNull()
  expect(refuse(root, paths, 'swift/Sources/Expires.swift')).toMatchObject({ origin_ref: 'seat.write_paths' })
  expect(refuse(root, paths, '../escape.kt')).toMatchObject({ origin_ref: 'seat.write_paths' })
})

test('the authority rail reads the same write_paths off the finished diff', () => {
  const hunk = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n+x\n`
  expect(authority(root, 'kotlin_specialist', hunk('kotlin/src/main/kotlin/Types.kt')))
    .toMatchObject({ outcome: 'pass' })
  expect(authority(root, 'kotlin_specialist', hunk('swift/Sources/Expires.swift')))
    .toMatchObject({ outcome: 'refuse', origin_ref: 'authority', spans: ['swift/Sources/Expires.swift:1 authority.write_paths'] })
})
