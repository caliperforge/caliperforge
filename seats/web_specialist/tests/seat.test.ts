import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { authority } from '../../../rails/authority/index.ts'
import { refuse } from '../../../runner/index.ts'
import { seat } from '../../../runner/rules.ts'
import { languageSeat } from '../../../runner/tests/language-seat.ts'
import { kernelPlan } from '../../../sequencer/home.ts'
import { fenceFor, languageFor } from '../../../sequencer/route.ts'
import { record } from '../../../store/files.ts'
import { planById, putPlan } from '../../../store/plans.ts'
import { builder } from '../../../templates/pr-path.ts'

const root = join(import.meta.dirname, '../../..')

languageSeat({
  seat: 'web_specialist',
  language: 'web',
  commands: ['Bash(node --check:*)'],
  allowed: ['node --check public/app.js'],
  listed: 'public/app.js',
  beside: 'public/index.html',
})

test('D3 the six checks come before the answer fence', () => {
  const [rules] = seat(root, 'web_specialist').prompt.split(/^Answer the /m)
  for (const line of [
    '- No catch-all "other" or "no target" grouping; every item is named from labelled data.',
    '- An issue number is never small and grey.',
    '- Long text expands and is never cut off.',
    '- A job page opens with the ask or the decision.',
    '- Every chart value is labelled.',
    '- Costs are in tokens, broken down by type.',
  ]) expect(rules).toContain(`\n${line}\n`)
})

const SITE = ['index.html', 'src/nav.ts']
const hunks = (paths: string[]) => paths.map((p) => `--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,1 @@\n+x\n`).join('')

function site() {
  const db = fresh(join(root, 'schema'))
  putPlan(db, { id: 1, pipe_id: 1, lane: 'site', seat: 'web_specialist', target_id: null, template: 'pr_path', state: 'running', queued_at: '2026-10-14', step: 0, retries: 0,
    origin: 'https://github.com/caliperforge/site/issues/1' })
  record(db, 1, SITE.map((path) => ({ path, is_new: false })))
  return { db, src: mkdtempSync(join(tmpdir(), 'site-')), fence: fenceFor(db, 1, seat(root, 'web_specialist').manifest.write_paths) }
}

test('1156c D1 a site plan routes to web_specialist', () => {
  const { db, src } = site()
  const plan = planById(db, 1)
  expect(kernelPlan(plan)).toBe(false)
  expect(builder(languageFor(db, plan, src))).toBe('web_specialist')
})

test('1156c D2 the listed site files are admitted', () => {
  const { src, fence } = site()
  expect(fence).toEqual(SITE)
  for (const path of SITE) expect(refuse(src, fence, path)).toBeNull()
  expect(authority(root, 'web_specialist', hunks(SITE), false, fence)).toMatchObject({ outcome: 'pass' })
})

test('1156c D3 a write outside the site files is refused', () => {
  const { src, fence } = site()
  for (const path of ['../caliperforge/cli/cf.ts', 'blog/index.html']) expect(refuse(src, fence, path)).toMatchObject({ origin_ref: 'seat.write_paths' })
  expect(authority(root, 'web_specialist', hunks(['blog/index.html']), false, fence)).toMatchObject({ outcome: 'refuse',
    spans: ['blog/index.html:1 authority.write_paths'] })
})

test('1156c D4 the prompt says caliperforge/site is public', () => {
  expect(seat(root, 'web_specialist').prompt).toContain(
    'On caliperforge/site, a public repository, nothing you write names a cost, a price, a funder, a person or a pay-catalog finding.')
})
