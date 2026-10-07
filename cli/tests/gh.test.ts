import { expect, test } from 'vitest'
import { rehearse, type Read, type Run } from '../gh.ts'

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

test('D1 an open rehearsal moves main and opens nothing', () => {
  const calls: string[][] = []
  rehearse(FORK, BRANCH, BASE, read('ahead', [15]), recorder(calls))
  expect(calls).toEqual([PATCH])
})

test('D2 no rehearsal moves main, then opens it', () => {
  const calls: string[][] = []
  rehearse(FORK, BRANCH, BASE, read('ahead', []), recorder(calls))
  expect(calls).toEqual([PATCH, CREATE])
})

test.each(['behind', 'identical'])('D3 %s sends no PATCH and still opens', (status) => {
  const calls: string[][] = []
  rehearse(FORK, BRANCH, BASE, read(status, []), recorder(calls))
  expect(calls).toEqual([CREATE])
})

test('D4 diverged throws and sends nothing', () => {
  const calls: string[][] = []
  expect(() => { rehearse(FORK, BRANCH, BASE, read('diverged', []), recorder(calls)) })
    .toThrow(`${FORK} main has diverged from ${BASE}`)
  expect(calls).toEqual([])
})

test('D5 a failed PATCH propagates and opens nothing', () => {
  const calls: string[][] = []
  expect(() => { rehearse(FORK, BRANCH, BASE, read('ahead', []), recorder(calls, true)) }).toThrow('422')
  expect(calls).toEqual([PATCH])
})
