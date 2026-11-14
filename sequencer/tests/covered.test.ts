import { expect, test } from 'vitest'
import type { Read } from '../../cli/gh.ts'
import { covered } from '../covered.ts'
import { SELF } from '../workspace.ts'
import { world } from './world.ts'

const now = new Date('2026-11-14T12:00:00.000Z')
const TITLE = '`powered()` drops the floor'
const url = (n: number) => `https://github.com/${SELF}/issues/${String(n)}`

const issue = (n: number, title = `t${String(n)}`, sha?: string) => ({ number: n, title, body: '', url: url(n),
  comments: { nodes: sha === undefined ? [] : [{ body: `landed on main as ${sha}` }] } })

type Node = ReturnType<typeof issue>

/** 250 closed issues in pages of 100, 100 and 50, one landed per page; `last` closes page 3. */
function pages(last: Node): Node[][] {
  const at = (from: number, size: number) => [...Array(size).keys()].map((i) => issue(from + i))
  return [[issue(1, 't1', 'aaaaaaa'), ...at(2, 99)], [issue(101, 't101', 'bbbbbbb'), ...at(102, 99)], [...at(201, 49), last]]
}

function searched(served: Node[][], open: object[] = [], more = false) {
  const reads: string[][] = []
  const read: Read = (args) => {
    if (args[0] !== 'api') return open
    reads.push(args)
    const after = args.find((a) => a.startsWith('after='))
    const at = after === undefined ? 0 : Number(after.slice('after=c'.length))
    return { data: { search: { pageInfo: { hasNextPage: more || at < served.length - 1, endCursor: `c${String(at + 1)}` }, nodes: served[at] } } }
  }
  return { read, reads }
}

const cover = (read: Read) => {
  const { db, root } = world()
  return covered(db, root, null, SELF, TITLE, 'body', now, read)
}

test('a landed match on the third page of closed issues is landed', () => {
  const { read, reads } = searched(pages(issue(250, 'powered() keeps the floor', '4cb0e875')))
  expect(cover(read)).toMatchObject({ verdict: 'landed', no: 250, url: url(250), sha: '4cb0e875', open: 0, landed: 3 })
  expect(reads.map((r) => r.find((a) => a.startsWith('after=')))).toEqual([undefined, 'after=c1', 'after=c2'])
})

test('250 closed issues with no match leave the draft filed', () => {
  expect(cover(searched(pages(issue(250))).read)).toMatchObject({ verdict: 'filed', open: 0, landed: 2 })
})

test('250 closed issues with no match find the covering open one', () => {
  const open = [{ number: 7, title: 'powered() applies the floor', body: '', url: url(7) }]
  expect(cover(searched(pages(issue(250)), open).read)).toMatchObject({ verdict: 'open', no: 7, url: url(7), plan: null, open: 1, landed: 2 })
})

test('a tenth page with a next page throws after ten reads', () => {
  const { read, reads } = searched([...Array(10).keys()].map((p) => [...Array(100).keys()].map((i) => issue(p * 100 + i + 1))), [], true)
  expect(() => cover(read)).toThrow(`gh issue list on ${SELF} hit its cap of 100; issues past it are unread`)
  expect(reads).toHaveLength(10)
})
