import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

export function scoped(): () => void {
  const before = process.env.TMPDIR
  const dir = mkdtempSync(join(tmpdir(), 'cf-test-'))
  process.env.TMPDIR = dir
  return () => {
    rmSync(dir, { recursive: true, force: true })
    if (before === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = before
  }
}

afterAll(scoped(), 120_000)
