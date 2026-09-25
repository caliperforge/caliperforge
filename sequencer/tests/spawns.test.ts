import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { tick } from '../index.ts'
import { get, MAIN } from '../workspace.ts'
import { built, CARRIED, internalPlan, ours, stub, watched, world } from './world.ts'

const ID = 2

test('D4 a step-3 tick spawns 11 git processes, 3 of them the live diff', async () => {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  const wire = watched([], w.root, ID)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  built(w.root, ID, 'export const landed = true')

  const bin = mkdtempSync(join(tmpdir(), 'cf-git-'))
  const log = join(bin, 'log')
  const path = process.env.PATH ?? ''
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nPATH='${path}' exec git "$@"\n`)
  chmodSync(join(bin, 'git'), 0o755)
  process.env.PATH = `${bin}:${path}`
  const fired = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire).finally(() => { process.env.PATH = path }))[0]

  const lines = readFileSync(log, 'utf8').trimEnd().split('\n')
  const base = get(w.root, ID, 'base.sha').trim()
  expect(lines).toHaveLength(11)
  expect(lines.filter((line) => line === `diff ${base}`)).toHaveLength(3)
  expect(lines.filter((line) => line === `rev-parse ${MAIN}`)).toHaveLength(1)
  expect(fired).toMatchObject({ step: 3, outcome: 'pass' })
})
