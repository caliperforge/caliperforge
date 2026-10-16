import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { homeOf, kernelPlan } from '../../sequencer/home.ts'
import { languageFor } from '../../sequencer/route.ts'
import { openPipes, PlanRow, type PipeRow } from '../../store/plans.ts'
import type { Db } from '../../store/index.ts'
import { builder } from '../../templates/pr-path.ts'
import type { Read } from '../gh.ts'
import { add } from '../plan.ts'

const schema = join(import.meta.dirname, '../../schema')
const ATELIER = 'https://github.com/caliperforge/atelier-web/issues/3'
const OURS = 'https://github.com/caliperforge/caliperforge/issues/25'

const canned = (url: string, labels: string[]): Read => () =>
  ({ number: Number(url.split('/').at(-1)), title: 'Now: three bands', body: 'the ask', url, labels: labels.map((name) => ({ name })) })

function db(): Db {
  const d = fresh(schema)
  d.prepare("INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES ('internal', 0, '00:00', '23:59', 1)").run()
  return d
}

const planOf = (d: Db, id: number | null): PlanRow => PlanRow.parse(d.prepare('SELECT * FROM plans WHERE id = ?').get(id))
const pipeOf = (d: Db, name: string): PipeRow => d.prepare('SELECT * FROM pipes WHERE name = ?').get(name) as PipeRow

test('loupe issue files on the loupe lane, pipe and web seat', () => {
  const d = db()
  const root = mkdtempSync(join(tmpdir(), 'cf-atelier-'))
  const filed = add(d, root, 'caliperforge/atelier-web#3', 'ceo', undefined, canned(ATELIER, ['lane:loupe']))
  expect(filed).toMatchObject({ state: 'queued', lane: 'loupe', seat: 'web_specialist' })
  const plan = planOf(d, filed.plan)
  expect(homeOf(plan)).toBe('caliperforge/atelier-web')
  expect(kernelPlan(plan)).toBe(false)
  expect(pipeOf(d, 'loupe')).toMatchObject({ enabled: 0, max_concurrent: 1 })
  expect(d.prepare('SELECT p.name FROM plans JOIN pipes p ON p.id = plans.pipe_id WHERE plans.id = ?').get(filed.plan))
    .toEqual({ name: 'loupe' })
})

test('an empty atelier-web checkout builds with the web seat', () => {
  const d = db()
  const filed = add(d, mkdtempSync(join(tmpdir(), 'cf-atelier-')), 'caliperforge/atelier-web#3', 'ceo', undefined, canned(ATELIER, ['lane:loupe']))
  expect(builder(languageFor(d, planOf(d, filed.plan), mkdtempSync(join(tmpdir(), 'cf-src-'))))).toBe('web_specialist')
})

test('a machine plan still builds here with the typescript seat', () => {
  const d = db()
  const filed = add(d, mkdtempSync(join(tmpdir(), 'cf-atelier-')), 'caliperforge/caliperforge#25', 'ceo', undefined, canned(OURS, ['lane:machine']))
  const plan = planOf(d, filed.plan)
  expect([homeOf(plan), kernelPlan(plan)]).toEqual(['caliperforge/caliperforge', true])
  expect(builder(languageFor(d, plan, mkdtempSync(join(tmpdir(), 'cf-src-'))))).toBe('typescript_specialist')
})

test('an issue off its lane\'s home repo is refused', () => {
  const d = db()
  const filed = add(d, mkdtempSync(join(tmpdir(), 'cf-atelier-')), 'caliperforge/caliperforge#25', 'ceo', undefined, canned(OURS, ['lane:loupe']))
  expect(filed.state).toBe('refused')
  expect(filed.why).toContain('the loupe lane builds in caliperforge/atelier-web')
})

test('with the lane off a loupe plan is not picked', () => {
  const d = db()
  add(d, mkdtempSync(join(tmpdir(), 'cf-atelier-')), 'caliperforge/atelier-web#3', 'ceo', undefined, canned(ATELIER, ['lane:loupe']))
  expect(openPipes(d, '12:00').map((p) => p.name)).not.toContain('loupe')
  d.prepare("UPDATE pipes SET enabled = 1 WHERE name = 'loupe'").run()
  expect(openPipes(d, '12:00').map((p) => p.name)).toContain('loupe')
})
