import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { MAP } from '../../cli/digests.ts'
import { map } from '../../cli/map.ts'

declare module 'vitest' {
  export interface ProvidedContext { bases: string }
}

type Tree = Record<string, string>

const repo = join(import.meta.dirname, '../..')
const WORKFLOW = '.github/workflows/ci.yml'

export const pkg = (scripts: Record<string, string>): string => JSON.stringify({ name: 'x', private: true, scripts })

export const TYPESCRIPT = { 'src/hello.ts': 'export const hello = (): string => "hi"\n' }
export const KOTLIN = { 'kotlin/build.gradle.kts': 'plugins { kotlin("jvm") }\n' }
export const HANDOUT = {
  'src/hello.ts': 'export const hello = (): string => "hi"\n',
  'src/bye.ts': 'export const bye = (): string => "bye"\n',
}

export const TIMEOUT = ' FAIL x.test.ts > a lap\nError: Test timed out in 5000ms.\n'
export const RED = { ...TYPESCRIPT, 'package.json': pkg({ lint: 'node -e "process.stderr.write(\'lint is red\'); process.exit(3)"' }) }
export const GREEN = { ...TYPESCRIPT, 'package.json': pkg({ lint: 'node -e ""', test: 'node -e ""' }) }
export const NAPPING = {
  ...TYPESCRIPT,
  'package.json': pkg({ test: `node -e "process.stderr.write('${TIMEOUT.replaceAll('\n', '\\n')}'); process.exit(1)"` }),
}
export const OOPS = {
  ...TYPESCRIPT,
  'package.json': pkg({ lint: `node -e "process.exit(require('node:fs').readFileSync('src/hello.ts', 'utf8').includes('oops') ? 3 : 0)"` }),
}

export const WORLDS: Tree[] = [TYPESCRIPT, KOTLIN, HANDOUT, RED]
export const OURS: [Tree, boolean][] = [[TYPESCRIPT, true], [TYPESCRIPT, false], [RED, true], [GREEN, true], [NAPPING, true], [OOPS, true]]

export function key(kind: 'world' | 'ours', files: Tree, ci: boolean): string {
  const sorted = Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
  return createHash('sha256').update(JSON.stringify([kind, ci, sorted])).digest('hex')
}

export function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function remotes(base: string, files: Tree): void {
  const upstream = join(base, 'acme/widget')
  mkdirSync(upstream, { recursive: true })
  git(upstream, ['init', '-q', '-b', 'main'])
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(upstream, path)), { recursive: true })
    writeFileSync(join(upstream, path), body)
  }
  git(upstream, ['add', '-A'])
  git(upstream, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'])
  git(base, ['clone', '-q', '--no-local', upstream, join(base, 'caliperforge/widget')])
}

function ours(dir: string, files: Tree, ci: boolean): void {
  if (ci) files = { ...files, [WORKFLOW]: 'on: push\n' }
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'receive.denyCurrentBranch', 'updateInstead'])
  for (const kernel of ['rules', 'seats']) cpSync(join(repo, kernel), join(dir, kernel), { recursive: true })
  for (const file of ['rules.seed.sql', '.gitattributes']) cpSync(join(repo, file), join(dir, file))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  writeFileSync(join(dir, MAP), map(dir))
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'])
}

export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'cf-bases-'))
  for (const files of WORLDS) remotes(join(dir, key('world', files, false)), files)
  for (const [files, ci] of OURS) ours(join(dir, key('ours', files, ci)), files, ci)
  project.provide('bases', dir)
  return () => { rmSync(dir, { recursive: true, force: true }) }
}
