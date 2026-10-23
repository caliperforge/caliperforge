import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const RUN = join(import.meta.dirname, '..', 'run.ts')

test.each([
  { given: 'no url', args: (out: string) => ['--out', out] },
  { given: 'no --out', args: () => ['https://example.org/'] },
  { given: 'a file: url', args: (out: string) => ['file:///etc/hosts', '--out', out] },
])('D6 $given exits 1 and writes nothing', ({ args }) => {
  const out = join(mkdtempSync(join(tmpdir(), 'site-snapshot-')), 'out')
  const ran = spawnSync(process.execPath, [RUN, ...args(out)], { encoding: 'utf8' })
  expect(ran.status).toBe(1)
  expect(ran.stderr).toContain('usage: node tools/site-snapshot/run.ts')
  expect(ran.stdout).toBe('')
  expect(existsSync(out)).toBe(false)
})
