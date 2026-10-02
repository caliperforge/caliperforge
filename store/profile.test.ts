import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { profile } from './profile.ts'

const REPO = join(import.meta.dirname, '..')

function root(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-profile-'))
  mkdirSync(join(dir, 'profiles/acme'), { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, 'profiles/acme', name), body)
  return dir
}

test('D1 a repo whose owner has no profiles folder reads as none', () => {
  expect(profile(mkdtempSync(join(tmpdir(), 'cf-profile-')), 'acme/widget')).toBeNull()
})

test('D2 pay-kit: org commit/pr shape, own checks, notes, sources', () => {
  const org = profile(REPO, 'solana-foundation/other')
  const kit = profile(REPO, 'solana-foundation/pay-kit')
  expect(kit).toMatchObject({ commit: org?.commit, pr: org?.pr, checks: { go: ['lint', 'test'] } })
  expect(Object.keys(kit ?? {}).sort()).toEqual(['checks', 'commit', 'intake', 'notes', 'pr', 'sources'])
  expect(kit?.intake).toEqual({ claim_first: false, pace: { prs: 1, days: 7 } })
  expect(profile(REPO, 'solana-foundation/surfpool')).not.toHaveProperty('intake')
})

test('D1 intake parses with claim_first defaulting to false', () => {
  const dir = root({ 'widget.yml': 'intake: { max_open_prs: 2 }\n' })
  expect(profile(dir, 'acme/widget')?.intake).toEqual({ claim_first: false, max_open_prs: 2 })
})

test('D6 a stray intake key or non-boolean claim_first is refused', () => {
  const extra = root({ 'widget.yml': 'intake: { labels: [bug] }\n' })
  expect(() => profile(extra, 'acme/widget')).toThrow(join(extra, 'profiles/acme/widget.yml'))
  const claim = root({ 'widget.yml': 'intake: { claim_first: sure }\n' })
  expect(() => profile(claim, 'acme/widget')).toThrow(join(claim, 'profiles/acme/widget.yml'))
})

test('D2 a field both files set comes whole from the repo file', () => {
  const dir = root({ '_org.yml': 'notes: [org]\ncommit: org\n', 'widget.yml': 'notes: [own, more]\n' })
  expect(profile(dir, 'acme/widget')).toEqual({ notes: ['own', 'more'], commit: 'org' })
})

test('D1 commit/PR rules parse, bad issue_ref/ai_trailer refused', () => {
  const rules = { subject: 'package', issue_ref: 'Fixes', ai_trailer: true, trailer: 'Co-Authored-By: Claude', disclosure: 'Made with AI.' }
  expect(profile(root({ '_org.yml': JSON.stringify(rules) }), 'acme/widget')).toEqual(rules)
  const closes = root({ '_org.yml': 'issue_ref: Closes\n' })
  expect(() => profile(closes, 'acme/widget')).toThrow(join(closes, 'profiles/acme/_org.yml'))
  const yes = root({ '_org.yml': 'ai_trailer: "yes"\n' })
  expect(() => profile(yes, 'acme/widget')).toThrow(join(yes, 'profiles/acme/_org.yml'))
})

test('#498a D1 our two repos name their builder and rails', () => {
  const atelier = profile(REPO, 'caliperforge/atelier')
  expect(profile(REPO, 'caliperforge/caliperforge')).toEqual({ builder: 'typescript_specialist',
    rails: { digests: true, ratchet: true, fence: true, tight_code: true, checks: 'ci' },
    commands: { npm: ['typecheck', 'lint', 'test'] } })
  expect(atelier).toEqual({ builder: 'swift_specialist',
    rails: { digests: false, ratchet: false, fence: false, tight_code: true, checks: 'local' },
    commands: { xcodebuild: atelier?.commands?.xcodebuild } })
})

test('D2 atelier holds the xcodebuild args checks.ts builds today', () => {
  expect(profile(REPO, 'caliperforge/atelier')?.commands?.xcodebuild?.join(' ')).toBe('-project Atelier.xcodeproj -scheme Atelier -destination platform=macOS -derivedDataPath .cf-derived -test-timeouts-enabled YES -default-test-execution-time-allowance 60 -maximum-test-execution-time-allowance 60 test')
})

test('D3 D4 a non-npm/xcodebuild command or unquoted 60 is refused', () => {
  for (const commands of ['{ gradle: [check] }', '{ xcodebuild: [-default-test-execution-time-allowance, 60] }']) {
    const dir = root({ 'widget.yml': `commands: ${commands}\n` })
    expect(() => profile(dir, 'acme/widget')).toThrow(join(dir, 'profiles/acme/widget.yml'))
  }
})

test('D2 a stray or non-boolean rail or github checks are refused', () => {
  for (const rails of ['{ lint: true }', '{ fence: sure }', '{ checks: github }']) {
    const dir = root({ 'widget.yml': `rails: ${rails}\n` })
    expect(() => profile(dir, 'acme/widget')).toThrow(join(dir, 'profiles/acme/widget.yml'))
  }
})

test('D3 a stray field or checks not a string list is refused', () => {
  const extra = root({ '_org.yml': 'commit: x\nlabels: [bug]\n' })
  expect(() => profile(extra, 'acme/widget')).toThrow(join(extra, 'profiles/acme/_org.yml'))
  const checks = root({ '_org.yml': 'checks:\n  go: lint\n' })
  expect(() => profile(checks, 'acme/widget')).toThrow(join(checks, 'profiles/acme/_org.yml'))
})

test('D6 a repo with no file of its own reads the org file alone', () => {
  expect(Object.keys(profile(REPO, 'solana-foundation/other') ?? {}).sort()).toEqual(['checks', 'commit', 'pr'])
  expect(profile(REPO, 'solana-foundation/other')?.checks).toEqual({ typescript: ['install', 'lint', 'typecheck', 'test'] })
})

test('kora parses Conventional subjects, Fixes and claim_first', () => {
  const org = profile(REPO, 'solana-foundation/other')
  const kora = profile(REPO, 'solana-foundation/kora')
  expect(kora).toMatchObject({ subject: 'conventional', issue_ref: 'Fixes', intake: { claim_first: true },
    checks: { rust: ['format', 'test'] }, commit: org?.commit })
  expect(Object.keys(kora ?? {}).sort()).toEqual(['checks', 'commit', 'disclosure', 'intake', 'issue_ref', 'notes', 'pr', 'sources', 'subject'])
  expect(kora?.pr).not.toBe(org?.pr)
  expect(kora?.pr).toMatch(/^Kora's template, section for section: .* with the second box checked\.$/)
  expect(kora?.disclosure).toMatch(/^## AI disclosure\n- \[x\] AI tooling was used\. .* before I opened it\.$/)
  expect(kora?.notes).toHaveLength(7)
  expect(kora?.notes?.[0]).toMatch(/^Kora ships a Justfile/)
  expect(kora?.notes?.[6]).toMatch(/^A mutation proof/)
})

test('both real repo profiles parse', () => {
  expect(profile(REPO, 'solana-foundation/surfpool')?.checks).toEqual({ rust: ['format', 'test', 'stage', 'generate', 'diff'] })
  expect(profile(REPO, 'solana-foundation/pay-kit')?.checks?.python).toEqual(['install', 'lint', 'typecheck', 'test'])
})
