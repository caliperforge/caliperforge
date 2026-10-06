import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Gh } from '../../rails/ci-green/index.ts'
import { cancel, moved, rehearsing } from '../retire.ts'
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

test('a rehearse cancels the fork’s running main runs', () => {
  const log: string[] = []
  const wire = { ...watched(log, root(), 1, runs(log, 'main', ['in_progress'])), rehearse: (fork: string, branch: string) => void log.push(`rehearse ${fork} ${branch}`) }
  rehearsing(FORK, NEW, wire)
  expect(log).toEqual([`rehearse ${FORK} ${NEW}`, `run cancel 1 --repo ${FORK}`])
})

test('a cancel that throws leaves the rest cancelled', () => {
  const log: string[] = []
  cancel(FORK, OLD, runs(log, OLD, ['queued', 'in_progress'], 1))
  expect(log).toEqual([`run cancel 2 --repo ${FORK}`])
})
