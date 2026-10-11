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
import type { Judged } from '../../verdict.ts'

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

function replying(name: string, sent: Packet[]): Provider {
  const reply = fixture('design', name)
  return {
    name: 'claude-agent-sdk',
    fire: (p) => {
      sent.push(p)
      return Promise.resolve({ text: reply, transcript_path: p.transcript, usage: { input: 1, cache: 0, output: 1 }, seconds: 0.5,
        ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
}

test('D1 design refuses a screenshot region against the mockup', async () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  loadReviews(db, root)
  const plan = planRow(db)
  const { dir, paths } = screens()
  const sent: Packet[] = []
  const out = await judge(db, root, 'design', plan, seeded({ screenshots: paths, defects: 'overflow at 390', mockup: 'light canvas' }),
    replying('region.reply.md', sent), TRANSCRIPT)
  expect(sent[0]?.prompt).toContain(`\n\n# Screenshots\n\n${paths.map((p) => `  - ${p}`).join('\n')}`
    + '\n\n# Defects the capture found\n\noverflow at 390\n\n# Mockup or ruling the brief names\n\nlight canvas')
  expect(sent[0]?.reads).toEqual([dir])
  expect(out.outcome).toMatchObject({ outcome: 'refuse', defect_class: 'design', origin_kind: 'ruling', origin_ref: 'reviewers.verdict' })
  expect(out.outcome.spans).toHaveLength(1)
  expect(out.outcome.spans[0]).toMatch(/^index\.html\.1440\.light\.png:\d+,\d+-\d+,\d+$/)
  expect(verdictRows(db, plan)).toMatchObject([{ id: out.verdict, gate: 'review', step: 4 }])
})

test('D2 screenshots go to design only, and design needs them', () => {
  const refused = { refusal: { path: 'screenshots' } }
  expect(benchPacket(root, 'design', seeded(), TRANSCRIPT)).toMatchObject(refused)
  expect(benchPacket(root, 'code_quality', seeded({ screenshots: screens().paths }), TRANSCRIPT)).toMatchObject(refused)
  expect(benchPacket(root, 'code_quality', seeded({ screenshots: screens().paths, system: 'Palette' }), TRANSCRIPT))
    .toMatchObject(refused)
})

const PALETTE = 'Palette: ink `#1a1a1a`, ground `#fafaf7`, accent `#2b5fd9`'
const SIGNAL = `${PALETTE}, signal \`#ff00aa\``
const PINK = ['--- a/style.css', '+++ b/style.css', '@@ -1 +1,2 @@', ' h1 {', '+  color: #ff00aa;'].join('\n')

async function held(diff: string, system: string, reply: string): Promise<{ prompt: string | undefined; outcome: Judged }> {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  loadReviews(db, root)
  const sent: Packet[] = []
  const input = seeded({ diff, screenshots: screens().paths, mockup: 'light canvas', system })
  const { outcome } = await judge(db, root, 'design', planRow(db), input, replying(reply, sent), TRANSCRIPT)
  return { prompt: sent[0]?.prompt, outcome }
}

test('D3 a colour DESIGN.md does not name is refused', async () => {
  const { prompt, outcome } = await held(PINK, PALETTE, 'unnamed.reply.md')
  expect(prompt).toContain(`# Mockup or ruling the brief names\n\nlight canvas\n\n# DESIGN.md in the checkout\n\n${PALETTE}`)
  expect(outcome).toMatchObject({ outcome: 'refuse', defect_class: 'design', spans: [expect.stringMatching(/^index\.html\.1440\.light\.png:/)] })
  expect(outcome.message).toContain(PALETTE)
})

test('D4 the colour passes once the diff adds it to DESIGN.md', async () => {
  const named = [PINK, '--- a/DESIGN.md', '+++ b/DESIGN.md', '@@ -1 +1 @@', `-${PALETTE}`, `+${SIGNAL}`].join('\n')
  const { prompt, outcome } = await held(named, SIGNAL, 'named.reply.md')
  expect(prompt).toContain(`# Mockup or ruling the brief names\n\nlight canvas\n\n# DESIGN.md in the checkout\n\n${SIGNAL}`)
  expect(outcome).toMatchObject({ outcome: 'pass', spans: [] })
  expect(outcome.message).toContain(SIGNAL)
})
