import { expect, test } from 'vitest'
import { at } from '../../templates/pr-path.ts'
import { thrown } from '../settle.ts'

const FETCH = "Command failed: git fetch --no-tags origin +main:refs/remotes/origin/main\nfatal: unable to access 'https://github.com/caliperforge/caliperforge.git/': Could not resolve host: github.com"

test('offline throw holds the step', () => {
  expect(thrown(at(3), FETCH)).toMatchObject({ outcome: 'pass', held: true, spans: ['offline'] })
  expect(thrown(at(2), 'getaddrinfo ENOTFOUND api.anthropic.com')).toMatchObject({ held: true })
})

test('other throws still refuse', () => {
  expect(thrown(at(6), 'plan 123 has no checkout at /x/src')).toMatchObject({ outcome: 'refuse', spans: ['threw: plan 123 has no checkout at /x/src'] })
})
