import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'
import { get } from './lanes.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D1 0068 opens p80 and p95 to 8, leaves p30, p60 and p100', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  expect(['p30', 'p60', 'p80', 'p95', 'p100'].map((p) => get(db, `lanes.band.${p}`))).toEqual(['3', '2', '8', '8', 'spot'])
})
