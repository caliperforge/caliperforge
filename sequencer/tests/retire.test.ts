import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Gh } from '../../rails/ci-green/index.ts'
import { cancel, moved, rehearsing } from '../retire.ts'
import { put } from '../workspace.ts'
import { watched } from './world.ts'

const FORK = 'caliperforge/widget'
const OLD = 'widget-12-a1-next'
const NEW = 'widget-12-a2-next'

/** `statuses` are the runs listed on `branch`, ids from 1; a `run cancel` goes in `log` once the first `throws` have thrown. */
function runs(log: string[], branch: string, statuses: string[], throws = 0): Gh {
  let thrown = 0
  return (args) => {
    if (args[1] === 'cancel') {
      if (thrown < throws) {
        thrown += 1
        throw new Error('run already completed')
      }
      log.push(args.join(' '))
      return ''
    }
    const on = args[args.indexOf('--branch') + 1] === branch ? statuses : []
    return JSON.stringify(on.map((status, i) => ({ status, url: `https://github.com/${FORK}/actions/runs/${String(i + 1)}` })))
  }
}

function root(): string {
  return mkdtempSync(join(tmpdir(), 'retire-'))
}

test('a new -next cancels only the old one’s unfinished runs', () => {
  const log: string[] = []
  const at = root()
  const wire = watched(log, at, 1, runs(log, OLD, ['queued', 'completed']))
  moved(at, 1, FORK, OLD, wire)
  moved(at, 1, FORK, NEW, wire)
  expect(log).toEqual([`unrehearse ${FORK} ${OLD}`, `run cancel 1 --repo ${FORK}`])
})

test('a first send or the same -next again retires nothing', () => {
  const log: string[] = []
  const at = root()
  const wire = watched(log, at, 1, runs(log, OLD, ['queued']))
  moved(at, 1, FORK, OLD, wire)
  moved(at, 1, FORK, OLD, wire)
  expect(log).toEqual([])
})

function rehearsed(log: string[], at: string, statuses: string[]): ReturnType<typeof watched> {
  return { ...watched(log, at, 1, runs(log, 'main', statuses)),
    rehearse: (fork: string, branch: string, base: string) => void log.push(`rehearse ${fork} ${branch} ${base}`) }
}

test('a rehearse cancels the fork’s running main runs', () => {
  const log: string[] = []
  const at = root()
  put(at, 1, 'base.sha', 'a1\n')
  rehearsing(at, 1, FORK, NEW, rehearsed(log, at, ['in_progress']))
  expect(log).toEqual([`rehearse ${FORK} ${NEW} a1`, `run cancel 1 --repo ${FORK}`])
})

test('D6 a rewritten base.sha reaches the next rehearse', () => {
  const log: string[] = []
  const at = root()
  const wire = rehearsed(log, at, [])
  put(at, 1, 'base.sha', 'a1\n')
  rehearsing(at, 1, FORK, NEW, wire)
  put(at, 1, 'base.sha', 'b2\n')
  rehearsing(at, 1, FORK, NEW, wire)
  expect(log).toEqual([`rehearse ${FORK} ${NEW} a1`, `rehearse ${FORK} ${NEW} b2`])
})

test('a cancel that throws leaves the rest cancelled', () => {
  const log: string[] = []
  cancel(FORK, OLD, runs(log, OLD, ['queued', 'in_progress'], 1))
  expect(log).toEqual([`run cancel 2 --repo ${FORK}`])
})
