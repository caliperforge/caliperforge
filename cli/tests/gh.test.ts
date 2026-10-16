import { expect, test } from 'vitest'
import { fileIssue, forward, installed, rehearse, type Read, type Run } from '../gh.ts'

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

function apps(selection: string, repos: string[], calls: string[][]): Read {
  return (args) => {
    calls.push(args)
    return args[1]?.startsWith('orgs/') === true
      ? { installations: [{ id: 7, app_slug: 'greptile-apps', repository_selection: selection }] }
      : { repositories: repos.map((name) => ({ full_name: name })) }
  }
}

test('D4 no greptile-apps installation is not installed', () => {
  expect(installed(FORK, () => ({ installations: [{ id: 3, app_slug: 'renovate', repository_selection: 'all' }] }))).toBe(false)
})

test('D4 all is installed after one read', () => {
  const calls: string[][] = []
  expect(installed(FORK, apps('all', [], calls))).toBe(true)
  expect(calls).toEqual([['api', 'orgs/caliperforge/installations?per_page=100']])
})

test('D4 selected without the fork is not installed', () => {
  expect(installed(FORK, apps('selected', ['caliperforge/other'], []))).toBe(false)
})

test('D4 selected with the fork is installed', () => {
  const calls: string[][] = []
  expect(installed(FORK, apps('selected', ['caliperforge/other', FORK], calls))).toBe(true)
  expect(calls[1]).toEqual(['api', 'user/installations/7/repositories?per_page=100'])
})

test('D4 selected but unreadable is assumed installed', () => {
  const read: Read = (args) => {
    if (String(args[1]).startsWith('user/')) throw new Error('HTTP 403')
    return { installations: [{ id: 7, app_slug: 'greptile-apps', repository_selection: 'selected' }] }
  }
  expect(installed(FORK, read)).toBe(true)
})

test('D4 selected listing failing for another reason throws', () => {
  const read: Read = (args) => {
    if (String(args[1]).startsWith('user/')) throw new Error('HTTP 502')
    return { installations: [{ id: 7, app_slug: 'greptile-apps', repository_selection: 'selected' }] }
  }
  expect(() => installed(FORK, read)).toThrow('HTTP 502')
})

const ISSUE = ['issue', 'create', '--repo', FORK, '--title', 'Part 1', '--body-file', '-']
const label = (l: string): string[] => ['label', 'create', l, '--repo', FORK, '--force']

type Call = [string[], string | undefined]

function filer(calls: Call[], failing?: string): Run {
  return (args, input) => {
    calls.push([args, input])
    if (args[0] === failing) throw new Error('HTTP 403')
    return args[0] === 'issue' ? 'https://github.com/o/r/issues/7\n' : ''
  }
}

test('D1 fileIssue creates each label, then files', () => {
  const calls: Call[] = []
  fileIssue(FORK, 'Part 1', 'the body', ['lane:loupe', 'P1'], filer(calls))
  expect(calls).toEqual([
    [label('lane:loupe'), undefined],
    [label('P1'), undefined],
    [[...ISSUE, '--label', 'lane:loupe', '--label', 'P1'], 'the body'],
  ])
})

test('D2 a failed label create files no issue', () => {
  const calls: Call[] = []
  expect(() => fileIssue(FORK, 'Part 1', 'b', ['lane:loupe'], filer(calls, 'label'))).toThrow('HTTP 403')
  expect(calls).toEqual([[label('lane:loupe'), undefined]])
})

test('D3 fileIssue returns the trimmed url', () => {
  expect(fileIssue(FORK, 'Part 1', 'b', ['P1'], filer([]))).toBe('https://github.com/o/r/issues/7')
})

test('D4 no labels files with no --label', () => {
  const calls: Call[] = []
  fileIssue(FORK, 'Part 1', 'b', [], filer(calls))
  expect(calls).toEqual([[ISSUE, 'b']])
})
