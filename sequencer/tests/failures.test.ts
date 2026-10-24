import { expect, test } from 'vitest'
import type { Gh } from '../../rails/ci-green/index.ts'
import { ofKind } from '../../store/events.ts'
import { failing, red } from '../failures.ts'
import { world } from './world.ts'

const FORK = 'caliperforge/pay-kit'

const RUN = `https://github.com/${FORK}/actions/runs/77`

const gh: Gh = (args) => args.includes('--log-failed')
  ? 'Ruby tests\trun\t2026-09-21T13:55:02.1234567Z   1) Failure: test_default [config_test.rb:187]\nRuby tests\trun\t2026-09-21T13:55:02.2Z Expected: 120'
  : JSON.stringify({ workflowName: 'Ruby' })

test('a red run names its workflow and its log without timestamps', () => {
  const { db, plan } = world()
  const found = red(db, plan, FORK, [`${RUN} ci.red`, 'commit:1 upstream.number'], gh)
  expect(found?.spans).toEqual(['ci.red Ruby'])
  expect(found?.log).toContain('Failure: test_default [config_test.rb:187]')
  expect(found?.log).not.toMatch(/2026-09-21T/)
})

test('a failed log names each failing job and step once', () => {
  expect(failing(FORK, '77', gh)).toEqual([{ job: 'Ruby tests', step: 'run' }])
})

test('no red run is no failure to hand back', () => {
  const { db, plan } = world()
  expect(red(db, plan, FORK, [`${RUN} ci.pending`], gh)).toBeNull()
})

test('an unreadable log still sends the builder its run', () => {
  const { db, plan } = world()
  const broken: Gh = () => { throw new Error('gh: not found') }
  expect(red(db, plan, FORK, [`${RUN} ci.red`], broken)).toMatchObject({ spans: ['ci.red run 77'] })
  expect(ofKind(db, 'swallowed').map((e) => [e.plan, e.actor, e.message])).toEqual([[plan, 'red', 'gh: not found'], [plan, 'red', 'gh: not found']])
})

const emptyLog = (jobs: () => string): Gh => (args) => {
  if (args.includes('--log-failed')) return '\n'
  if (args.includes('conclusion,jobs')) return jobs()
  if (args[0] === 'api') return [...Array(80).keys()].map((i) => `2026-09-21T13:55:02.1234567Z line ${String(i)}`).join('\n')
  return JSON.stringify({ workflowName: 'Ruby' })
}

test('an empty failed log falls back to the failed job and its log', () => {
  const steps = [{ name: 'setup', number: 1, conclusion: 'success' }, { name: 'run', number: 2, conclusion: 'failure' }]
  const jobs = [{ databaseId: 9, name: 'Ruby tests', conclusion: 'failure', steps }]
  const { db, plan } = world()
  const found = red(db, plan, FORK, [`${RUN} ci.red`], emptyLog(() => JSON.stringify({ conclusion: 'failure', jobs })))
  expect(found?.log).toContain('Ruby tests: run\nline 20\n')
  expect(found?.log).toMatch(/line 79$/)
  expect(found?.log).not.toMatch(/2026-/)
})

test('an empty failed log and no failed job: how the run ended', () => {
  const { db, plan } = world()
  const found = red(db, plan, FORK, [`${RUN} ci.red`], emptyLog(() => JSON.stringify({ conclusion: 'startup_failure', jobs: [] })))
  expect(found?.log).toMatch(/## Ruby\n\n\S/)
  expect(found?.log).toContain('run 77 ended startup_failure with no failed job')
})

test('an empty failed log whose jobs cannot be read says so', () => {
  const { db, plan } = world()
  const found = red(db, plan, FORK, [`${RUN} ci.red`], emptyLog(() => { throw new Error('gh: 502') }))
  expect(found?.spans).toEqual(['ci.red Ruby'])
  expect(found?.log).toContain('(the failed log could not be read)')
  expect(ofKind(db, 'swallowed').map((e) => [e.plan, e.actor, e.message])).toEqual([[plan, 'red', 'gh: 502']])
})
