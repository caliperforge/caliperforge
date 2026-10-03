import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import type { Provider } from '../../../providers/kind.ts'
import { load } from '../../../runner/rules.ts'
import { putPlan } from '../../../store/plans.ts'
import { profile } from '../../../store/profile.ts'
import { addTarget } from '../../../store/targets.ts'
import { judge, loadReviews } from '../../bench.ts'
import { packs } from '../../packs.ts'

const root = join(import.meta.dirname, '../../..')
const PAY_KIT = 'solana-foundation/pay-kit'

const diffOf = (...paths: string[]): string =>
  paths.map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new\n`).join('')

const rules = (seat: string): string => {
  const prompt = readFileSync(join(root, 'seats', seat, 'prompt.md'), 'utf8')
  return prompt.slice(0, prompt.indexOf('\nAnswer the ') + 1)
}

test('Kotlin then Python rules, then every pay-kit note', () => {
  const out = packs(root, diffOf('kotlin/src/main/Runner.kt', 'python/pay/client.py'), PAY_KIT)
  const kotlin = out.indexOf(rules('kotlin_specialist'))
  const python = out.indexOf(rules('python_specialist'))
  expect(out.match(/^# Language rules$/gm)).toHaveLength(1)
  expect(kotlin).toBeGreaterThan(out.indexOf('# Language rules'))
  expect(python).toBeGreaterThan(kotlin)
  expect(out.indexOf(`# Notes on ${PAY_KIT}`)).toBeGreaterThan(python)
  const notes = profile(root, PAY_KIT)?.notes ?? []
  expect(notes).toHaveLength(22)
  for (const note of notes) expect(out).toContain(`\n- ${note}`)
})

test('a .ts-only diff gets the TypeScript rules and no notes', () => {
  const out = packs(root, diffOf('reviews/packs.ts', 'reviews/bench.ts'), null)
  expect(out).toContain(rules('typescript_specialist'))
  expect(out).not.toContain('# Notes on')
})

test('each text is its seat prompt up to the answer line', () => {
  const out = packs(root, diffOf('kotlin/Runner.kt', 'python/client.py', 'src/a.ts'), null)
  for (const seat of ['kotlin_specialist', 'python_specialist', 'typescript_specialist']) {
    expect(out).toContain(rules(seat))
  }
  expect(out).not.toContain('done:')
  expect(out).not.toContain('summary:')
})

const kotlinExamples = readFileSync(join(root, 'reviews/examples/kotlin.md'), 'utf8')

test('Kotlin examples sit after the Kotlin rules, before Python', () => {
  const out = packs(root, diffOf('kotlin/Runner.kt', 'python/client.py'), null)
  const examples = out.indexOf(kotlinExamples)
  expect(examples).toBeGreaterThan(out.indexOf(rules('kotlin_specialist')))
  expect(examples).toBeLessThan(out.indexOf(rules('python_specialist')))
})

test('a language with no examples file adds nothing', () => {
  expect(packs(root, diffOf('python/client.py'), null).endsWith(rules('python_specialist'))).toBe(true)
})

test('every Kotlin example cites a pay-kit span at its sha', () => {
  const rows = kotlinExamples.split('\n').filter((l) => l.startsWith('- '))
  expect(rows).toHaveLength(4)
  for (const row of rows) expect(row).toMatch(/caliperforge\/pay-kit@[0-9a-f]{7}:\S+:\d+/)
  for (const sha of ['efff41c', '8c59ab9', '2291822', 'c4341ee']) expect(kotlinExamples).toContain(`@${sha}:`)
})

test('a Swift and Ruby diff carries both example lists', () => {
  const out = packs(root, diffOf('swift/Sources/Main.swift', 'ruby/lib/config.rb'), null)
  for (const language of ['swift', 'ruby']) expect(out).toContain(readFileSync(join(root, `reviews/examples/${language}.md`), 'utf8'))
})

test('a Lua diff ends with the Lua rules and carries no examples', () => {
  const out = packs(root, diffOf('lua/pay.lua'), null)
  expect(out.endsWith(rules('lua_specialist'))).toBe(true)
  expect(out).not.toContain('## Refused in')
})

test('the examples folder is not a reviewer', () => {
  expect(loadReviews(fresh(join(root, 'schema')), root)).toEqual(['code_quality', 'senior_review'])
})

test('a diff no language claims carries nothing', () => {
  expect(packs(root, diffOf('README.md', 'docs/x.md'), null)).toBe('')
})

test('judge()\'s prompt ends with the target\'s rules and notes', async () => {
  const db = fresh(join(root, 'schema'))
  db.pragma('foreign_keys = OFF')
  load(db, root)
  loadReviews(db, root)
  const target = addTarget(db, { account_id: 1, repo: PAY_KIT, issue_no: 1, named_merger: 'm', state: 'ready',
    evidence_measured_at: '2026-10-02', evidence: `https://github.com/${PAY_KIT}/issues/1` })
  const plan = 1
  putPlan(db, { id: plan, pipe_id: 1, target_id: target, template: 'research', state: 'running', queued_at: '2026-10-02',
    step: 4, retries: 0 })
  const fixture = (name: string): string => readFileSync(join(root, 'reviews/code_quality/fixtures', name), 'utf8')
  const diff = fixture('seeded.diff')
  const prompts: string[] = []
  const provider: Provider = {
    name: 'claude-agent-sdk',
    fire: (p) => {
      prompts.push(p.prompt)
      return Promise.resolve({ text: fixture('clean.reply.md'), transcript_path: p.transcript, usage: { input: 1, cache: 0, output: 1 },
        seconds: 0, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
  await judge(db, root, 'code_quality', plan, { repo: '/tmp/cf-review', issue: fixture('issue.md'), diff }, provider,
    join(tmpdir(), 'cf-packs.transcript.jsonl'))
  expect(prompts[0]?.endsWith(packs(root, diff, PAY_KIT))).toBe(true)
  expect(prompts[0]).toContain(`# Notes on ${PAY_KIT}`)
})
