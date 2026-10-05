import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parse } from 'yaml'
import { gate } from '../../../providers/claude-agent-sdk/index.ts'
import type { Packet } from '../../../providers/kind.ts'
import { authority } from '../../../rails/authority/index.ts'
import { packs } from '../../../reviews/packs.ts'
import { packet, refuse } from '../../../runner/index.ts'
import { Seat, rules, seat } from '../../../runner/rules.ts'
import { builder } from '../../../templates/pr-path.ts'

const root = join(import.meta.dirname, '../../..')

test('the manifest declares seat, model, effort, tools and paths', () => {
  expect(Seat.parse(seat(root, 'kotlin_specialist').manifest)).toMatchObject({
    seat: 'kotlin_specialist',
    effort: 'high',
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(gradle:*)', 'Bash(./gradlew:*)'],
    write_paths: ['kotlin'],
  })
})

test('the roster carries the seat and it loads as a rules row', () => {
  const row = rules(root).find((r) => r.id === 'kotlin_specialist')
  expect(row).toMatchObject({ kind: 'card', path: 'rules/roster.yaml' })
})

test('the build prompt closes with the handback fence', () => {
  expect(seat(root, 'kotlin_specialist', 'build').prompt).toContain('- id: D1')
})

test('a rebuild lists every case, carrying untouched rows forward', () => {
  expect(seat(root, 'kotlin_specialist', 'build').prompt).toContain(
    "A rebuild's fence lists every case again: carry forward the rows the refusal did not touch, update the ones it did.",
  )
})

test('a kotlin tree picks this seat, an unknown language none', () => {
  expect(builder('kotlin')).toBe('kotlin_specialist')
  expect(builder(null)).toBe('typescript_specialist')
  expect(builder('cobol')).toBe(null)
})

test('write_paths admit the kotlin module and refuse the rest', () => {
  const paths = seat(root, 'kotlin_specialist').manifest.write_paths
  expect(refuse(root, paths, 'kotlin/src/main/kotlin/Types.kt')).toBeNull()
  expect(refuse(root, paths, 'swift/Sources/Expires.swift')).toMatchObject({ origin_ref: 'seat.write_paths' })
  expect(refuse(root, paths, '../escape.kt')).toMatchObject({ origin_ref: 'seat.write_paths' })
})

test('the authority rail reads the same write_paths off the diff', () => {
  const hunk = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n+x\n`
  expect(authority(root, 'kotlin_specialist', hunk('kotlin/src/main/kotlin/Types.kt')))
    .toMatchObject({ outcome: 'pass' })
  expect(authority(root, 'kotlin_specialist', hunk('swift/Sources/Expires.swift')))
    .toMatchObject({ outcome: 'refuse', origin_ref: 'authority', spans: ['swift/Sources/Expires.swift:1 authority.write_paths'] })
})

const ran = (p: Packet, command: string) =>
  gate(p, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } } as never)

test('the seat runs only gradle, and not a chained command', () => {
  const { manifest, prompt } = seat(root, 'kotlin_specialist')
  const p = packet(manifest, prompt, '', '', root, join(root, 'x.transcript.jsonl'))
  expect(ran(p, 'gradle -p kotlin check')).toEqual({ continue: true })
  expect(ran(p, './gradlew -p kotlin check')).toEqual({ continue: true })
  for (const command of ['curl https://example.com', 'git push origin HEAD', 'gradle check && curl x', 'echo hi > ../../base.sha']) {
    expect(ran(p, command)).toMatchObject({
      continue: true,
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: `ruling:seat.tools refuses the command ${JSON.stringify(command)}` },
    })
  }
})

test('D1: the build mode, not the prompt, holds the framing', () => {
  const { prompt } = seat(root, 'kotlin_specialist')
  expect(prompt).not.toContain('You build')
  expect(prompt).not.toContain('- id: D1')
  const build = seat(root, 'kotlin_specialist', 'build').prompt.replace(/\s+/g, ' ')
  expect(build).toContain('You build against the brief below. One checkout, one step.')
  expect(build).toContain(
    'On an outside plan you may write only the files the brief lists under `## Files`; otherwise, only inside the seat\'s write paths. Any other write is refused and the step ends there.',
  )
})

test('D1: What to check opens the prompt with the Kotlin checks', () => {
  const { prompt } = seat(root, 'kotlin_specialist')
  expect(prompt.startsWith('# kotlin_specialist\n\n## What to check\n')).toBe(true)
  const checks = prompt.slice(0, prompt.indexOf('## Test conventions'))
  for (const word of ['hash', 'opaque', 'Gradle', '!!', 'runCatching']) expect(checks).toContain(word)
})

test('D2: review mode reads What to check before the profile', () => {
  const p = 'kotlin/Runner.kt'
  const out = packs(root, `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new\n`, null)
  const at = out.indexOf('## What to check')
  expect(at).toBeGreaterThan(-1)
  expect(at).toBeLessThan(out.indexOf('## Profile'))
})

test('D3: the test conventions parse and pick out test files', () => {
  const block = /## Test conventions\n\n```yaml\n([\s\S]*?)```/.exec(seat(root, 'kotlin_specialist').prompt)?.[1] ?? ''
  const conventions = parse(block) as { test_path: string; assertions: string[]; skip_markers: string[] }
  expect(conventions.assertions).toContain('assertEquals')
  expect(conventions.skip_markers).toContain('@Ignore')
  const path = new RegExp(conventions.test_path)
  expect(path.test('kotlin/src/test/kotlin/MainTest.kt')).toBe(true)
  expect(path.test('kotlin/src/main/kotlin/Main.kt')).toBe(false)
})

test('D4: an outside-fence packet drops the own-repo-only line', () => {
  const { manifest, prompt } = seat(root, 'kotlin_specialist')
  const p = packet(manifest, prompt, '', '', root, join(root, 'x.transcript.jsonl'), false, ['kotlin/src/Pay.kt'])
  expect(p.prompt.replace(/\s+/g, ' ')).not.toContain('is the only tree you may write in')
})

test('the prompt says the brief\'s files are handed', () => {
  expect(seat(root, 'kotlin_specialist').prompt).toContain('follow it under `# The files`')
})

test('the prompt says every command runs in the foreground', () => {
  expect(seat(root, 'kotlin_specialist').prompt).toContain(
    'Every command runs in the foreground; wait for it to finish, and answer only after it has.',
  )
})
