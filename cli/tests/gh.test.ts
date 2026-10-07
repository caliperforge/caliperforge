import { expect, test } from 'vitest'
import { forward, rehearse, type Read, type Run } from '../gh.ts'

const FORK = 'caliperforge/widget'
const BRANCH = 'widget-12-a1-next'
const BASE = '9f47b85f'
const PATCH = ['api', '-X', 'PATCH', `repos/${FORK}/git/refs/heads/main`, '-f', `sha=${BASE}`]
const CREATE = ['pr', 'create', '--repo', FORK, '--base', 'main', '--head', BRANCH,
  '--title', 'CI rehearsal only (do not merge)', '--body', 'Fork CI only. Do not merge.']

function read(status: string, open: number[]): Read {
  return (args) => args[0] === 'api' ? { status } : open.map((number) => ({ number }))
}

function recorder(calls: string[][], fails = false): Run {
  return (args) => {
    calls.push(args)
    if (fails) throw new Error('422 not a fast forward')
    return ''
  }
}

test('D2 ahead moves main', () => {
  const calls: string[][] = []
  forward(FORK, BASE, read('ahead', []), recorder(calls))
  expect(calls).toEqual([PATCH])
})

test.each(['behind', 'identical'])('D2 %s sends no PATCH', (status) => {
  const calls: string[][] = []
  forward(FORK, BASE, read(status, []), recorder(calls))
  expect(calls).toEqual([])
})

test('D2 diverged throws and sends nothing', () => {
  const calls: string[][] = []
  expect(() => { forward(FORK, BASE, read('diverged', []), recorder(calls)) })
    .toThrow(`${FORK} main has diverged from ${BASE}`)
  expect(calls).toEqual([])
})

test('D2 a failed PATCH propagates', () => {
  const calls: string[][] = []
  expect(() => { forward(FORK, BASE, read('ahead', []), recorder(calls, true)) }).toThrow('422')
  expect(calls).toEqual([PATCH])
})

test('D3 an open rehearsal opens nothing and moves nothing', () => {
  const calls: string[][] = []
  rehearse(FORK, BRANCH, read('ahead', [15]), recorder(calls))
  expect(calls).toEqual([])
})

test('D3 no rehearsal opens one and moves nothing', () => {
  const calls: string[][] = []
  rehearse(FORK, BRANCH, read('ahead', []), recorder(calls))
  expect(calls).toEqual([CREATE])
})
