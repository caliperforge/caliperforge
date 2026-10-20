import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import type { Run } from '../checks.ts'
import type { Gate } from '../gates.ts'
import { fresh, problems } from '../inherited.ts'

const LAB = 'input/fsh/profiles/observation-lab.fsh'

const PREFIX = '../../../../../cf_v2/.cf/work/1438/src/'

function nested(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-inherited-test-'))
  for (const path of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), '')
  }
  return dir
}

const said = (file: string, message = 'error Cardinality of code is 1..1'): string => `${message}\n  File: ${file}\n  Line: 3`

test.each([
  { shape: 'absolute under cwd', file: (cwd: string) => join(cwd, LAB) },
  { shape: 'npx-relative', file: () => PREFIX + LAB },
  { shape: 'under a temp worktree', file: () => `/private/var/folders/xy/T/cf-inherited-x/tree/${LAB}` },
])('D1 $shape is keyed on the checkout', ({ file }) => {
  const cwd = nested([LAB])
  expect(problems(said(file(cwd)), cwd)).toEqual([`error Cardinality of code is 1..1\n  File: ${LAB}`])
})

test('D2 a File: with no part under cwd is kept as printed', () => {
  expect(problems(said('../../elsewhere/gone.fsh'), nested([]))).toEqual(['error Cardinality of code is 1..1\n  File: ../../elsewhere/gone.fsh'])
})

test('D5 a suffix holding .. never keys a path outside cwd', () => {
  const root = nested(['outside.fsh', 'tree/x'])
  expect(problems(said('gone/../outside.fsh'), join(root, 'tree'))).toEqual(['error Cardinality of code is 1..1\n  File: gone/../outside.fsh'])
})

const MISSING = 'error Missing slice'

function based(): { src: string; base: string } {
  const src = nested(['sushi-config.yaml', LAB, 'input/fsh/b.fsh'])
  const git = (args: string[]): string => execFileSync('git', args, { cwd: src, encoding: 'utf8' }).trim()
  git(['init', '-q'])
  git(['add', '-A'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'])
  return { src, base: git(['rev-parse', 'HEAD']) }
}

const atBase: Run = (...[, cwd]) => ({ ok: false, code: '20', output: [said(join(cwd, LAB)), said(join(cwd, 'input/fsh/b.fsh'), MISSING)].join('\n') })

const gate = (base: string): Gate => ({ script: 'sushi', bin: 'npx', args: [], dir: '', base })

test('D3 errors at base under another prefix pass', () => {
  const { src, base } = based()
  expect(fresh(src, gate(base), [said(PREFIX + LAB), said(`${PREFIX}input/fsh/b.fsh`, MISSING)].join('\n'), atBase)).toEqual([])
})

test('D4 one error the head adds is the only key returned', () => {
  const { src, base } = based()
  const head = [said(PREFIX + LAB), said(`${PREFIX}input/fsh/b.fsh`, MISSING), said(PREFIX + LAB, 'error Unknown parent')].join('\n')
  expect(fresh(src, gate(base), head, atBase)).toEqual([`error Unknown parent\n  File: ${LAB}`])
})
