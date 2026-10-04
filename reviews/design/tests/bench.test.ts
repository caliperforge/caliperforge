import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import type { Packet, Provider } from '../../../providers/kind.ts'
import { planRow } from '../../../runner/index.ts'
import { benchPacket } from '../../../runner/packet.ts'
import { load } from '../../../runner/rules.ts'
import { verdictRows } from '../../../store/verdict.ts'
import { judge, loadReviews } from '../../bench.ts'

const root = join(import.meta.dirname, '../../..')
const TRANSCRIPT = join(tmpdir(), 'cf-design.transcript.jsonl')
const repo = '/tmp/cf-review'

function fixture(review: string, name: string): string {
  return readFileSync(join(root, 'reviews', review, 'fixtures', name), 'utf8')
}

function seeded(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { repo, issue: fixture('code_quality', 'issue.md'), diff: fixture('code_quality', 'seeded.diff'), ...over }
}

function screens(): { dir: string; paths: string[] } {
  const dir = join(mkdtempSync(join(tmpdir(), 'cf-design-')), 'design')
  mkdirSync(dir)
  const paths = ['index.html.1440.light.png', 'index.html.390.dark.png'].map((name) => join(dir, name))
  for (const path of paths) writeFileSync(path, 'png')
  return { dir, paths }
}

test('D1 design refuses a screenshot region against the mockup', async () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  loadReviews(db, root)
  const plan = planRow(db)
  const { dir, paths } = screens()
  const sent: Packet[] = []
  const reply = fixture('design', 'region.reply.md')
  const capture: Provider = {
    name: 'claude-agent-sdk',
    fire: (p) => {
      sent.push(p)
      return Promise.resolve({ text: reply, transcript_path: p.transcript, usage: { input: 1, cache: 0, output: 1 }, seconds: 0.5,
        ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
  const out = await judge(db, root, 'design', plan, seeded({ screenshots: paths, defects: 'overflow at 390', mockup: 'light canvas' }),
    capture, TRANSCRIPT)
  expect(sent[0]?.prompt).toContain(`\n\n# Screenshots\n\n${paths.map((p) => `  - ${p}`).join('\n')}`
    + '\n\n# Defects the capture found\n\noverflow at 390\n\n# Mockup or ruling the brief names\n\nlight canvas')
  expect(sent[0]?.reads).toEqual([dir])
  expect(out.outcome).toMatchObject({ outcome: 'refuse', defect_class: 'design' })
  expect(out.outcome.spans).toHaveLength(1)
  expect(out.outcome.spans[0]).toMatch(/^index\.html\.1440\.light\.png:\d+,\d+-\d+,\d+$/)
  expect(verdictRows(db, plan)).toMatchObject([{ id: out.verdict, gate: 'review', step: 4 }])
})

test('D2 screenshots go to design only, and design needs them', () => {
  const refused = { refusal: { path: 'screenshots' } }
  expect(benchPacket(root, 'design', seeded(), TRANSCRIPT)).toMatchObject(refused)
  expect(benchPacket(root, 'code_quality', seeded({ screenshots: screens().paths }), TRANSCRIPT)).toMatchObject(refused)
})
