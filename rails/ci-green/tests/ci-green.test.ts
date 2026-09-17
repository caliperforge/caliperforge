import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { record } from '../../record.ts'
import { ciGreen, type Gh, type Head } from '../index.ts'

const root = join(import.meta.dirname, '../../..')
const head: Head = { fork: 'caliperforge/caliperforge', branch: 'p4-rails', sha: '9f2c1ab' }

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, name), 'utf8')
}

function gh(name: string): Gh {
  return () => fixture(name)
}

test('refuses a red fork run and every upstream number named', () => {
  const verdict = ciGreen(head, { body: fixture('red.body.md'), commits: ['fix loader; closes #412'] }, gh('red.gh.json'))
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.origin_kind).toBe('rail')
  expect(verdict.origin_ref).toBe('ci-green')
  expect(verdict.spans).toEqual([
    'https://github.com/caliperforge/caliperforge/actions/runs/1 ci.red',
    'body:1 upstream.number',
    'body:3 upstream.number',
    'commit:1 upstream.number',
  ])
})

test('passes a green fork run whose text names only our own repo', () => {
  const verdict = ciGreen(head, { body: fixture('green.body.md'), commits: ['resolve the loader path'] }, gh('green.gh.json'))
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('asks gh for the last run on the branch of the fork', () => {
  let asked: string[] = []
  ciGreen(head, { body: '', commits: [] }, (args) => {
    asked = args
    return fixture('green.gh.json')
  })
  expect(asked).toEqual(['run', 'list', '--repo', 'caliperforge/caliperforge', '--branch', 'p4-rails', '--limit', '1', '--json', 'headSha,status,conclusion,url'])
})

test('refuses a run that is missing, stale against the head, or still pending', () => {
  const cases: [string, string][] = [
    ['[]', 'caliperforge/caliperforge:9f2c1ab ci.missing'],
    ['[{"headSha":"deadbee","status":"completed","conclusion":"success","url":"u"}]', 'caliperforge/caliperforge:9f2c1ab ci.missing'],
    ['[{"headSha":"9f2c1ab","status":"in_progress","conclusion":"","url":"u"}]', 'u ci.pending'],
  ]
  for (const [json, span] of cases) {
    expect(ciGreen(head, { body: '', commits: [] }, () => json).spans).toEqual([span])
  }
})

test('writes a verdicts row the store accepts', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const verdict = ciGreen(head, { body: fixture('red.body.md'), commits: [] }, gh('red.gh.json'))
  const id = record(db, join(import.meta.dirname, '..'), plan, verdict, 0.01)
  const row = db.prepare('SELECT gate, step, kind, outcome, rail_id, origin_kind, origin_ref FROM verdicts WHERE id = ?').get(id)
  expect(row).toEqual({ gate: 'ready', step: 6, kind: 'rail', outcome: 'refuse', rail_id: 'ci-green', origin_kind: 'rail', origin_ref: 'ci-green' })
})
