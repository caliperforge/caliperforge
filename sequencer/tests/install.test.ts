import { userInfo } from 'node:os'
import { expect, test } from 'vitest'
import type { Run } from '../checks.ts'
import { refresh } from '../install.ts'

const WEB = '/tmp/atelier_web'

const STEPS = [
  'git fetch --no-tags origin main',
  'git merge --ff-only FETCH_HEAD',
  `launchctl kickstart -k gui/${String(userInfo().uid)}/com.caliperforge.atelier-web`,
]

function recording(log: string[], fails?: string, cwds: string[] = []): Run {
  return (...[args, cwd, bin = 'npm']) => {
    const name = bin === 'git' ? `git ${args[0] ?? ''}` : bin
    log.push(`${bin} ${args.join(' ')}`)
    cwds.push(cwd)
    return name === fails ? { ok: false, code: '1', output: 'error: it broke' } : { ok: true, output: '' }
  }
}

test('fast-forwards the web clone, then restarts the web Atelier', () => {
  const log: string[] = []
  const cwds: string[] = []
  const posts: string[] = []
  refresh(recording(log, undefined, cwds), (title) => posts.push(title), WEB)
  expect(log).toEqual(STEPS)
  expect(cwds).toEqual([WEB, WEB, WEB])
  expect(posts).toEqual([])
})

test.each(['git fetch', 'git merge', 'launchctl'])('a failed %s posts one alert and stops', (fails) => {
  const log: string[] = []
  const posts: string[] = []
  refresh(recording(log, fails), (title, body) => posts.push(`${title}\n${body}`), WEB)
  expect(log).toEqual(STEPS.slice(0, STEPS.findIndex((s) => s.startsWith(fails)) + 1))
  expect(posts).toHaveLength(1)
  expect(posts[0]).toContain('Atelier web did not update')
  expect(posts[0]).toContain('error: it broke')
})
