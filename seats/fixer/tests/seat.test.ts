import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { refuse } from '../../../runner/index.ts'
import { seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')

test('D1: no src write path and no src-writing git', () => {
  const { manifest } = seat(root, 'fixer')
  expect(manifest.write_paths).toEqual(['issue.md', 'ask.md', 'step-2.handback.md', 'base.sha'])
  expect(manifest.tools).not.toContain('Bash(git -C src mv:*)')
  expect(manifest.tools).not.toContain('Bash(git -C src add:*)')
})

test('D2: the packet refuses src/index.ts and admits issue.md', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cf-fixer-'))
  const paths = seat(root, 'fixer').manifest.write_paths
  expect(refuse(cwd, paths, 'src/index.ts')).toMatchObject({ origin_ref: 'seat.write_paths', path: 'src/index.ts' })
  expect(refuse(cwd, paths, 'issue.md')).toBeNull()
})

test('D3: a code stop is diagnosed, not edited', () => {
  const { prompt } = seat(root, 'fixer')
  expect(prompt).not.toContain('git -C src mv')
  expect(prompt).not.toContain('generated file')
  expect(prompt).toContain('A stop in the code itself')
  expect(prompt).toContain('diagnose it and never edit it')
})
