import { expect, test } from 'vitest'
import type { Gh } from '../../rails/ci-green/index.ts'
import { red } from '../failures.ts'

const FORK = 'caliperforge/pay-kit'

const RUN = `https://github.com/${FORK}/actions/runs/77`

const gh: Gh = (args) => args.includes('--log-failed')
  ? 'Ruby tests\trun\t2026-09-21T13:55:02.1234567Z   1) Failure: test_default [config_test.rb:187]\nRuby tests\trun\t2026-09-21T13:55:02.2Z Expected: 120'
  : JSON.stringify({ workflowName: 'Ruby' })

test('a red run names its workflow and carries its failed log without timestamps', () => {
  const found = red(FORK, [`${RUN} ci.red`, 'commit:1 upstream.number'], gh)
  expect(found?.spans).toEqual(['ci.red Ruby'])
  expect(found?.log).toContain('Failure: test_default [config_test.rb:187]')
  expect(found?.log).not.toMatch(/2026-09-21T/)
})

test('no red run is no failure to hand back', () => {
  expect(red(FORK, [`${RUN} ci.pending`], gh)).toBeNull()
})

test('a log gh cannot read still sends the builder the run it came from', () => {
  const broken: Gh = () => { throw new Error('gh: not found') }
  expect(red(FORK, [`${RUN} ci.red`], broken)).toMatchObject({ spans: ['ci.red run 77'] })
})
