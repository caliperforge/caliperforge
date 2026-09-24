import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { SELF } from '../workspace.ts'
import { OURS, WORLDS } from './bases.ts'
import { ours, world } from './world.ts'

function gitless(run: () => void): void {
  const path = process.env.PATH
  process.env.PATH = mkdtempSync(join(tmpdir(), 'cf-path-'))
  try { run() } finally { process.env.PATH = path }
}

test('D1 every world and ours tree is copied from its base with no git on PATH', () => {
  gitless(() => {
    for (const files of WORLDS) {
      const { root } = world('warm', undefined, files)
      for (const repo of ['acme/widget', 'caliperforge/widget']) expect(existsSync(join(root, 'remotes', repo, '.git/HEAD'))).toBe(true)
    }
    for (const [files, ci] of OURS) {
      const { root } = world()
      ours(root, files, ci)
      expect(existsSync(join(root, 'remotes', SELF, '.git/HEAD'))).toBe(true)
    }
  })
})

test('D2 a tree with no base throws and names it', () => {
  gitless(() => {
    const { root } = world()
    expect(() => world('warm', undefined, { 'nope.ts': '' })).toThrow('nope.ts')
    expect(() => { ours(root, { 'nope.ts': '' }) }).toThrow('nope.ts')
  })
})
