import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import type { Run } from '../checks.ts'
import { reinstall, type Places } from '../install.ts'

function places(cloned: boolean): Places {
  const root = mkdtempSync(join(tmpdir(), 'cf-install-'))
  const at = { clone: join(root, 'atelier_build'), derived: join(root, 'derived'), app: join(root, 'Applications/Atelier.app') }
  mkdirSync(at.app, { recursive: true })
  writeFileSync(join(at.app, 'build'), 'old')
  if (cloned) mkdirSync(join(at.clone, '.git'), { recursive: true })
  return at
}

const held = (at: Places): string => existsSync(join(at.app, 'build')) ? readFileSync(join(at.app, 'build'), 'utf8') : 'none'

function recording(at: Places, log: string[], fails?: string): Run {
  return (...[args, , bin = 'npm']) => {
    const name = bin === 'git' ? `git ${args[0] ?? ''}` : bin
    log.push(`${name} ${held(at)}`)
    if (name === fails) return { code: 1, output: 'error: it broke' }
    if (name === 'git clone') mkdirSync(join(at.clone, '.git'), { recursive: true })
    if (bin === 'xcodebuild') {
      const built = join(at.derived, 'Build/Products/Release/Atelier.app')
      mkdirSync(built, { recursive: true })
      writeFileSync(join(built, 'build'), 'new')
    }
    return { code: 0, output: '' }
  }
}

test('a built app is quit, swapped for the new bundle in place and reopened; an existing clone is fetched, not cloned', () => {
  const at = places(true)
  const log: string[] = []
  const posts: string[] = []
  reinstall(recording(at, log), (title) => posts.push(title), at)
  expect(log).toEqual(['git fetch old', 'git checkout old', 'xcodebuild old', 'osascript old', 'open new'])
  expect(held(at)).toBe('new')
  expect(readdirSync(dirname(at.app))).toEqual(['Atelier.app'])
  expect(posts).toEqual([])
})

test('a missing clone is cloned before the fetch', () => {
  const at = places(false)
  const log: string[] = []
  reinstall(recording(at, log), () => undefined, at)
  expect(log.slice(0, 4)).toEqual(['git clone old', 'git fetch old', 'git checkout old', 'xcodebuild old'])
})

test.each(['git fetch', 'xcodebuild'])('a failed %s posts one alert and touches nothing installed', (fails) => {
  const at = places(true)
  const log: string[] = []
  const posts: string[] = []
  reinstall(recording(at, log, fails), (title, body) => posts.push(`${title}\n${body}`), at)
  expect(log.at(-1)).toBe(`${fails} old`)
  expect(posts).toHaveLength(1)
  expect(posts[0]).toContain('Atelier did not build')
  expect(posts[0]).toContain('error: it broke')
  expect(held(at)).toBe('old')
  expect(readdirSync(dirname(at.app))).toEqual(['Atelier.app'])
})
