import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { gates, outsideLanguage } from '../gates.ts'

function fixture(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-gates-'))
  mkdirSync(join(dir, marker, '..'), { recursive: true })
  writeFileSync(join(dir, marker), '')
  return dir
}

test('D1 kotlin and swift are outside languages', () => {
  expect(outsideLanguage('kotlin')).toBe('kotlin')
  expect(outsideLanguage('swift')).toBe('swift')
})

test('D2 kotlin with no Justfile runs gradle in its folder', () => {
  expect(gates(fixture('kotlin/build.gradle.kts'), { language: 'kotlin', files: ['kotlin/src/main/kotlin/Runner.kt'] }))
    .toEqual([{ script: 'test', bin: 'gradle', args: ['installDist', 'test'], dir: 'kotlin' }])
})

test('D3 swift with no Justfile builds, then tests, in its folder', () => {
  expect(gates(fixture('swift/Package.swift'), { language: 'swift', files: ['swift/Sources/PayKit/Memo.swift'] })).toEqual([
    { script: 'build', bin: 'swift', args: ['build'], dir: 'swift' },
    { script: 'test', bin: 'swift', args: ['test'], dir: 'swift' },
  ])
})

function nested(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-gates-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  return dir
}

const PACKAGE = JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest run' } })

const ts = (src: string, file = 'ts/src/a.ts'): ReturnType<typeof gates> => gates(src, { language: 'typescript', files: [file] })

test('D1 typescript is an outside language', () => {
  expect(outsideLanguage('typescript')).toBe('typescript')
})

test('D2 D6 pnpm installs frozen, runs only defined scripts', () => {
  expect(ts(nested({ 'ts/package.json': PACKAGE, 'ts/pnpm-lock.yaml': '', 'ts/src/a.ts': '' }))).toEqual([
    { script: 'install', bin: 'pnpm', args: ['install', '--frozen-lockfile'], dir: 'ts' },
    { script: 'lint', bin: 'pnpm', args: ['run', 'lint'], dir: 'ts' },
    { script: 'test', bin: 'pnpm', args: ['run', 'test'], dir: 'ts' },
  ])
})

test('D3 workspace installs at its lockfile, runs in the package', () => {
  expect(ts(nested({ 'ts/pnpm-lock.yaml': '', 'ts/packages/mpp/package.json': PACKAGE }), 'ts/packages/mpp/src/a.ts')).toEqual([
    { script: 'install', bin: 'pnpm', args: ['install', '--frozen-lockfile'], dir: 'ts' },
    { script: 'lint', bin: 'pnpm', args: ['run', 'lint'], dir: 'ts/packages/mpp' },
    { script: 'test', bin: 'pnpm', args: ['run', 'test'], dir: 'ts/packages/mpp' },
  ])
})

test('D4 package-lock.json gives npm ci, then npm run', () => {
  expect(ts(nested({ 'ts/package.json': PACKAGE, 'ts/package-lock.json': '' }))).toEqual([
    { script: 'install', bin: 'npm', args: ['ci'], dir: 'ts' },
    { script: 'lint', bin: 'npm', args: ['run', 'lint'], dir: 'ts' },
    { script: 'test', bin: 'npm', args: ['run', 'test'], dir: 'ts' },
  ])
})

test('D5 a Justfile runs its recipes after the lockfile install', () => {
  expect(ts(nested({ 'ts/Justfile': 'lint:\n    echo lint\n\ntest:\n    echo test\n', 'ts/package.json': PACKAGE, 'ts/pnpm-lock.yaml': '' }))).toEqual([
    { script: 'install', bin: 'pnpm', args: ['install', '--frozen-lockfile'], dir: 'ts' },
    { script: 'lint', bin: 'just', args: ['--justfile', 'Justfile', 'lint'], dir: 'ts' },
    { script: 'test', bin: 'just', args: ['--justfile', 'Justfile', 'test'], dir: 'ts' },
  ])
})

const just = (script: string): ReturnType<typeof gates>[number] => ({ script, bin: 'just', args: ['--justfile', 'Justfile', script], dir: '' })

test('D1 a Justfile ts-build runs after install, before its gates', () => {
  const justfile = 'ts-install:\n    pnpm install\n\nts-build:\n    cd typescript && pnpm build\n\nts-test:\n    pnpm test\n\ntest: ts-test\n'
  expect(ts(nested({ Justfile: justfile, 'package.json': PACKAGE, 'pnpm-lock.yaml': '' }), 'typescript/src/a.ts')).toEqual([
    { script: 'install', bin: 'pnpm', args: ['install', '--frozen-lockfile'], dir: '' },
    just('ts-build'),
    just('ts-test'),
  ])
})

const POLYGLOT = {
  Justfile: 'ts-build:\n    b\n\nts-test:\n    t\n\nkt-lint:\n    l\n\nkt-test:\n    k\n\ntest: ts-test kt-test\n',
  'Package.swift': '',
  'package.json': PACKAGE,
  'pnpm-lock.yaml': '',
  'Sources/PayKit/Memo.swift': '',
  'kotlin/src/main/kotlin/Runner.kt': '',
  'typescript/src/a.ts': '',
}

test('D1 swift on a polyglot root runs swift, not the root test', () => {
  expect(gates(nested(POLYGLOT), { language: 'swift', files: ['Sources/PayKit/Memo.swift'] })).toEqual([
    { script: 'build', bin: 'swift', args: ['build'], dir: '' },
    { script: 'test', bin: 'swift', args: ['test'], dir: '' },
  ])
})

test('D2 kotlin on a polyglot root runs its kt- recipes', () => {
  expect(gates(nested(POLYGLOT), { language: 'kotlin', files: ['kotlin/src/main/kotlin/Runner.kt'] })).toEqual([just('kt-lint'), just('kt-test')])
})

test('D3 typescript on a polyglot root runs its ts- recipes', () => {
  expect(ts(nested(POLYGLOT), 'typescript/src/a.ts')).toEqual([
    { script: 'install', bin: 'pnpm', args: ['install', '--frozen-lockfile'], dir: '' },
    just('ts-build'),
    just('ts-test'),
  ])
})

test('D2 ts-build is preferred over build, and build runs alone', () => {
  const src = (justfile: string): string => nested({ Justfile: justfile, 'package.json': PACKAGE })
  expect(ts(src('build:\n    b\n\nts-build:\n    t\n\ntest:\n    x\n'), 'src/a.ts')).toEqual([just('ts-build'), just('test')])
  expect(ts(src('build:\n    b\n\ntest:\n    x\n'), 'src/a.ts')).toEqual([just('build'), just('test')])
})

test('D4 with no Justfile a package.json build script is not run', () => {
  const scripts = JSON.stringify({ scripts: { build: 'tsc', lint: 'eslint .', test: 'vitest run' } })
  expect(ts(nested({ 'ts/package.json': scripts, 'ts/pnpm-lock.yaml': '' }))).toEqual([
    { script: 'install', bin: 'pnpm', args: ['install', '--frozen-lockfile'], dir: 'ts' },
    { script: 'lint', bin: 'pnpm', args: ['run', 'lint'], dir: 'ts' },
    { script: 'test', bin: 'pnpm', args: ['run', 'test'], dir: 'ts' },
  ])
})

test('D6 no lockfile: no install gate, npm runs the scripts', () => {
  expect(ts(nested({ 'ts/package.json': PACKAGE }))).toEqual([
    { script: 'lint', bin: 'npm', args: ['run', 'lint'], dir: 'ts' },
    { script: 'test', bin: 'npm', args: ['run', 'test'], dir: 'ts' },
  ])
})
