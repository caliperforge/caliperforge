import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { gate } from '../../../providers/claude-agent-sdk/index.ts'
import type { Packet } from '../../../providers/kind.ts'
import { authority } from '../../../rails/authority/index.ts'
import { packet, refuse } from '../../../runner/index.ts'
import { Seat, rules, seat } from '../../../runner/rules.ts'
import { languageOf } from '../../../sequencer/workspace.ts'
import { builder } from '../../../templates/pr-path.ts'

const root = join(import.meta.dirname, '../../..')
const SEAT = 'swift_specialist'

const tree = (entries: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-swift-'))
  for (const e of entries) {
    if (e.endsWith('/')) mkdirSync(join(dir, e), { recursive: true })
    else writeFileSync(join(dir, e), '')
  }
  return dir
}

test('the manifest declares seat, model, effort, tools and write_paths', () => {
  expect(Seat.parse(seat(root, SEAT).manifest)).toMatchObject({
    seat: SEAT,
    effort: 'high',
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(xcodebuild:*)', 'Bash(swift:*)'],
    write_paths: ['Atelier', 'AtelierTests', 'Atelier.xcodeproj'],
  })
})

test('the roster carries the seat', () => {
  expect(rules(root).find((r) => r.id === SEAT)).toMatchObject({ kind: 'card', path: 'rules/roster.yaml' })
})

test('an xcode project or a swift package routes to this seat', () => {
  expect(builder(languageOf(tree(['Atelier.xcodeproj/', 'Atelier/'])))).toBe(SEAT)
  expect(builder(languageOf(tree(['Package.swift'])))).toBe(SEAT)
  expect(builder(languageOf(tree(['kotlin/'])))).toBe('kotlin_specialist')
  expect(builder(languageOf(tree(['package.json'])))).toBe('typescript_specialist')
})

test('the prompt carries the test command, the design line and the fence', () => {
  const { prompt } = seat(root, SEAT)
  expect(prompt).toContain("xcodebuild -project Atelier.xcodeproj -scheme Atelier -destination 'platform=macOS'")
  expect(prompt).toContain('design/v2/TWO_PAGER.md')
  expect(prompt).toContain('- id: D1')
  expect(prompt).toContain(
    "A rebuild's fence lists every case again: carry forward the rows the refusal did not touch, update the ones it did.",
  )
  expect(prompt).toContain('follow it under `# The files`')
})

test('the prompt carries the own-repo rules and the outside comment-density line', () => {
  const { prompt } = seat(root, SEAT)
  for (const line of [
    'On our own repository:',
    '- A comment states, in one sentence, a fact the code cannot say.',
    '- Why a change was made goes in the commit message, never in a comment.',
    '- Code the change replaces is deleted in the same job.',
    '- A fallback records that it fell back.',
    '- New logic goes in a new file rather than growing a file past its budget.',
    "On anyone else's repository, match its comment density instead.",
  ]) expect(prompt).toContain(line)
})

test('write_paths admit the app and its tests and refuse everything beside them', () => {
  const paths = seat(root, SEAT).manifest.write_paths
  expect(refuse(root, paths, 'Atelier/Views/NowView.swift')).toBeNull()
  expect(refuse(root, paths, 'AtelierTests/NowViewTests.swift')).toBeNull()
  expect(refuse(root, paths, 'Archive/Services/Old.swift')).toMatchObject({ origin_ref: 'seat.write_paths' })
  expect(refuse(root, paths, '../escape.swift')).toMatchObject({ origin_ref: 'seat.write_paths' })
})

test('the authority rail reads the same write_paths off the diff', () => {
  const hunk = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n+x\n`
  expect(authority(root, SEAT, hunk('Atelier/Views/NowView.swift'))).toMatchObject({ outcome: 'pass' })
  expect(authority(root, SEAT, hunk('Archive/Old.swift')))
    .toMatchObject({ outcome: 'refuse', spans: ['Archive/Old.swift:1 authority.write_paths'] })
})

const ran = (p: Packet, command: string) =>
  gate(p, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } } as never)

test('the seat may run xcodebuild and swift and nothing else', () => {
  const { manifest, prompt } = seat(root, SEAT)
  const p = packet(manifest, prompt, '', '', root, join(root, 'x.transcript.jsonl'))
  expect(ran(p, "xcodebuild -project Atelier.xcodeproj -scheme Atelier -destination 'platform=macOS' test")).toEqual({ continue: true })
  expect(ran(p, 'swift build')).toEqual({ continue: true })
  for (const command of ['open /Applications/Atelier.app', 'xcodebuild test && curl x', 'cp -R x /Applications']) {
    expect(ran(p, command)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  }
})
