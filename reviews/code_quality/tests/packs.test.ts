import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import type { Provider } from '../../../providers/kind.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
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

test('a Kotlin and Python diff on pay-kit gets both rules in diff order, then every pay-kit note', () => {
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

test('a .ts-only diff on our own repo gets the TypeScript rules and no notes', () => {
  const out = packs(root, diffOf('reviews/packs.ts', 'reviews/bench.ts'), null)
  expect(out).toContain(rules('typescript_specialist'))
  expect(out).not.toContain('# Notes on')
})

test('each carried text is the seat prompt up to its answer line, without the answer fence', () => {
  const out = packs(root, diffOf('kotlin/Runner.kt', 'python/client.py', 'src/a.ts'), null)
  for (const seat of ['kotlin_specialist', 'python_specialist', 'typescript_specialist']) {
    expect(out).toContain(rules(seat))
  }
  expect(out).not.toContain('done:')
  expect(out).not.toContain('summary:')
})

test('a diff no language claims carries nothing', () => {
  expect(packs(root, diffOf('README.md', 'docs/x.md'), null)).toBe('')
})

test('judge() sends a prompt that ends with the rules and notes of the plan\'s target', async () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  loadReviews(db, root)
  const plan = planRow(db)
  db.prepare(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
    VALUES (1, ?, '2026-10-02', 2, 1, '2026-10-02', 3, 4, 'warm', ?)`).run(PAY_KIT, `https://github.com/${PAY_KIT}`)
  const target = addTarget(db, { account_id: 1, repo: PAY_KIT, issue_no: 1, named_merger: 'm', state: 'ready',
    evidence_measured_at: '2026-10-02', evidence: `https://github.com/${PAY_KIT}/issues/1` })
  db.prepare('UPDATE plans SET target_id = ? WHERE id = ?').run(target, plan)
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
