import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parse } from 'yaml'
import { gate } from '../../../providers/claude-agent-sdk/index.ts'
import type { Packet } from '../../../providers/kind.ts'
import { authority } from '../../../rails/authority/index.ts'
import { packs } from '../../../reviews/packs.ts'
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

test('the manifest declares seat, model, effort, tools and paths', () => {
  expect(Seat.parse(seat(root, SEAT).manifest)).toMatchObject({
    seat: SEAT,
    effort: 'high',
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(xcodebuild:*)', 'Bash(swift:*)'],
    write_paths: ['Atelier', 'AtelierTests', 'Atelier.xcodeproj', 'swift'],
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

test('the prompt carries the test command, design line and fence', () => {
  const { prompt } = seat(root, SEAT)
  expect(prompt).toContain("xcodebuild -project Atelier.xcodeproj -scheme Atelier -destination 'platform=macOS'")
  expect(prompt).toContain('design/v2/TWO_PAGER.md')
  expect(prompt).toContain('- id: D1')
  expect(prompt).toContain(
    "A rebuild's fence lists every case again: carry forward the rows the refusal did not touch, update the ones it did.",
  )
  expect(prompt).toContain('follow it under `# The files`')
})

test('the prompt carries the own-repo and outside comment rules', () => {
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

test('the prompt keeps views on plain values, with no #Preview', () => {
  const { prompt } = seat(root, SEAT)
  expect(prompt).not.toContain('#Preview')
  expect(prompt).toContain('a view takes plain values')
})

test('D1: a behaviour is tested on its service or model', () => {
  const prompt = seat(root, SEAT).prompt.replace(/\s+/g, ' ')
  expect(prompt).toContain('Show a behaviour with a test on the service or model that produces it: the rows, the values, the plan a row opens.')
  expect(prompt).toContain('Write an accessibility-tree UI test only when the behaviour is the control itself (a button exists and is labelled), at most one per screen.')
})

test('D2, D3: the prompt states both fences and both openings', () => {
  const prompt = seat(root, SEAT).prompt.replace(/\s+/g, ' ')
  expect(prompt).toContain('On an outside plan you may write only the files the brief lists under `## Files`; on our own repository, only under `Atelier/`, `AtelierTests/` and `Atelier.xcodeproj/`. Any other write is refused and the step ends there.')
  expect(prompt).toContain("You build Swift against the issue below. One checkout, one step. On an outside plan you build that repository's Swift package as its maintainers would. On our own repository you are an expert macOS SwiftUI engineer on Atelier, the CEO's read-only window onto the machine, and the Atelier design rules below apply only there.")
})

test('D1: What to check opens the prompt with the Swift checks', () => {
  const { prompt } = seat(root, SEAT)
  expect(prompt.startsWith(`# ${SEAT}\n\n## What to check\n`)).toBe(true)
  const checks = prompt.slice(0, prompt.indexOf('## Test conventions'))
  for (const word of ['description', 'opaque', 'Package.swift', 'try!', 'fatalError', 'Codable']) expect(checks).toContain(word)
})

test('D2: review mode reads What to check before the profile', () => {
  const p = 'swift/Sources/Main.swift'
  const out = packs(root, `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new\n`, null)
  const at = out.indexOf('## What to check')
  expect(at).toBeGreaterThan(-1)
  expect(at).toBeLessThan(out.indexOf('You build Swift'))
})

test('D3: the test conventions parse and pick out test files', () => {
  const block = /## Test conventions\n\n```yaml\n([\s\S]*?)```/.exec(seat(root, SEAT).prompt)?.[1] ?? ''
  const conventions = parse(block) as { test_path: string; assertions: string[]; skip_markers: string[] }
  expect(conventions.assertions).toContain('#expect')
  expect(conventions.skip_markers).toContain('.disabled(')
  const path = new RegExp(conventions.test_path)
  expect(path.test('swift/Tests/PayKitTests/MemoTests.swift')).toBe(true)
  expect(path.test('swift/Sources/PayKit/Memo.swift')).toBe(false)
})

test('D4: an outside-fence packet drops the own-repo-only lines', () => {
  const { manifest, prompt } = seat(root, SEAT)
  const p = packet(manifest, prompt, '', '', root, join(root, 'x.transcript.jsonl'), false, ['kotlin/src/Pay.kt'])
  const text = p.prompt.replace(/\s+/g, ' ')
  expect(text).not.toContain('are the only trees you may')
  expect(text).not.toContain("as an expert macOS SwiftUI engineer on Atelier, the CEO's")
})

test('write_paths admit the app and its tests and refuse the rest', () => {
  const paths = seat(root, SEAT).manifest.write_paths
  expect(refuse(root, paths, 'Atelier/Views/NowView.swift')).toBeNull()
  expect(refuse(root, paths, 'AtelierTests/NowViewTests.swift')).toBeNull()
  expect(refuse(root, paths, 'swift/Sources/PayKit/Memo.swift')).toBeNull()
  expect(refuse(root, paths, 'Archive/Services/Old.swift')).toMatchObject({ origin_ref: 'seat.write_paths' })
  expect(refuse(root, paths, 'Archive/Old.swift')).toMatchObject({ origin_ref: 'seat.write_paths' })
  expect(refuse(root, paths, '../escape.swift')).toMatchObject({ origin_ref: 'seat.write_paths' })
})

test('D6 the kotlin seat still refuses a swift write', () => {
  const paths = seat(root, 'kotlin_specialist').manifest.write_paths
  expect(refuse(root, paths, 'swift/Sources/Expires.swift')).toMatchObject({ origin_ref: 'seat.write_paths' })
})

test('the authority rail reads the same write_paths off the diff', () => {
  const hunk = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n+x\n`
  expect(authority(root, SEAT, hunk('Atelier/Views/NowView.swift'))).toMatchObject({ outcome: 'pass' })
  expect(authority(root, SEAT, hunk('Archive/Old.swift')))
    .toMatchObject({ outcome: 'refuse', spans: ['Archive/Old.swift:1 authority.write_paths'] })
})

const ran = (p: Packet, command: string, background?: boolean) =>
  gate(p, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: background === undefined ? { command } : { command, run_in_background: background } } as never)

const XCODEBUILD = "xcodebuild -project Atelier.xcodeproj -scheme Atelier -destination 'platform=macOS' test"

test('the seat may run xcodebuild and swift and nothing else', () => {
  const { manifest, prompt } = seat(root, SEAT)
  const p = packet(manifest, prompt, '', '', root, join(root, 'x.transcript.jsonl'))
  expect(ran(p, "xcodebuild -project Atelier.xcodeproj -scheme Atelier -destination 'platform=macOS' test")).toEqual({ continue: true })
  expect(ran(p, 'swift build')).toEqual({ continue: true })
  for (const command of ['open /Applications/Atelier.app', 'xcodebuild test && curl x', 'cp -R x /Applications']) {
    expect(ran(p, command)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  }
})

test('a background xcodebuild is denied and the seat stays on', () => {
  const { manifest, prompt } = seat(root, SEAT)
  const p = packet(manifest, prompt, '', '', root, join(root, 'x.transcript.jsonl'))
  const denied = ran(p, XCODEBUILD, true)
  expect(denied).toMatchObject({
    continue: true,
    hookSpecificOutput: {
      permissionDecision: 'deny',
      permissionDecisionReason: 'ruling:seat.tools refuses run_in_background: run it in the foreground and wait for it',
    },
  })
  expect(denied.stopReason).toBeUndefined()
  expect(ran(p, XCODEBUILD, false)).toEqual({ continue: true })
  expect(ran(p, XCODEBUILD)).toEqual({ continue: true })
})

test('both prompt commands cap each test at 60s and pass the gate', () => {
  const { manifest, prompt } = seat(root, SEAT)
  const flagged = '-derivedDataPath .cf-derived -test-timeouts-enabled YES -default-test-execution-time-allowance 60 -maximum-test-execution-time-allowance 60 test'
  expect(prompt.split(flagged)).toHaveLength(3)
  expect(prompt).not.toContain('.cf-derived test')
  const p = packet(manifest, prompt, '', '', root, join(root, 'x.transcript.jsonl'))
  expect(ran(p, `xcodebuild -project Atelier.xcodeproj -scheme Atelier -destination 'platform=macOS' ${flagged}`)).toEqual({ continue: true })
})
