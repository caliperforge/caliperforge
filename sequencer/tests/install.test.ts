import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import type { Run } from '../checks.ts'
import { refresh, reinstall, type Places } from '../install.ts'

function places(cloned: boolean): Places {
  const root = mkdtempSync(join(tmpdir(), 'cf-install-'))
  const at = { clone: join(root, 'atelier_build'), derived: join(root, 'derived'), app: join(root, 'Applications/Atelier.app'), web: join(root, 'atelier_web') }
  mkdirSync(at.app, { recursive: true })
  mkdirSync(join(at.web, '.git'), { recursive: true })
  writeFileSync(join(at.app, 'build'), 'old')
  if (cloned) mkdirSync(join(at.clone, '.git'), { recursive: true })
  return at
}

const held = (at: Places): string => existsSync(join(at.app, 'build')) ? readFileSync(join(at.app, 'build'), 'utf8') : 'none'

function recording(at: Places, log: string[], fails?: string, cwds: string[] = []): Run {
  return (...[args, cwd, bin = 'npm']) => {
    const name = bin === 'git' ? `git ${args[0] ?? ''}` : bin
    log.push(`${name} ${held(at)}`)
    cwds.push(cwd)
    if (name === fails) return { ok: false, code: '1', output: 'error: it broke' }
    if (name === 'git clone') mkdirSync(join(at.clone, '.git'), { recursive: true })
    if (bin === 'xcodebuild') {
      const built = join(at.derived, 'Build/Products/Release/Atelier.app')
      mkdirSync(built, { recursive: true })
      writeFileSync(join(built, 'build'), 'new')
    }
    return { ok: true, output: '' }
  }
}

test('swaps the app in place; fetches an existing clone',() => {
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

test('atelier-web fast-forwards the web clone and nothing else', () => {
  const at = places(true)
  const log: string[] = []
  const cwds: string[] = []
  const posts: string[] = []
  refresh('caliperforge/atelier-web', recording(at, log, undefined, cwds), (title) => posts.push(title), at)
  expect(log).toEqual(['git fetch old', 'git merge old'])
  expect(cwds).toEqual([at.web, at.web])
  expect(posts).toEqual([])
})

test('atelier still reinstalls and leaves the web clone alone', () => {
  const at = places(true)
  const log: string[] = []
  const cwds: string[] = []
  refresh('caliperforge/atelier', recording(at, log, undefined, cwds), () => undefined, at)
  expect(log).toEqual(['git fetch old', 'git checkout old', 'xcodebuild old', 'osascript old', 'open new'])
  expect(cwds).not.toContain(at.web)
})

test.each(['git fetch', 'git merge'])('a failed web %s posts one alert and stops', (fails) => {
  const at = places(true)
  const log: string[] = []
  const posts: string[] = []
  refresh('caliperforge/atelier-web', recording(at, log, fails), (title, body) => posts.push(`${title}\n${body}`), at)
  expect(log.at(-1)).toBe(`${fails} old`)
  expect(posts).toHaveLength(1)
  expect(posts[0]).toContain('Atelier web did not update')
  expect(posts[0]).toContain('error: it broke')
})
