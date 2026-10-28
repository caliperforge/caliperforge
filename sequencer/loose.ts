import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Gate } from './gates.ts'

/** One throwaway environment for all three, so pyright resolves `import pytest`. */
const ENV = ['run', '--no-project', '--with', 'ruff', '--with', 'pyright', '--with', 'pytest']

const REQUIREMENTS = ['requirements.txt', 'requirements-dev.txt']

/** `python -m pytest`, unlike `pytest`, puts the root on `sys.path`, so the whole suite imports the tree from there. */
export function loose(src: string, files: string[]): Gate[] {
  const py = files.filter((f) => f.endsWith('.py') && existsSync(join(src, f)))
  if (py.length === 0) return []
  const env = [...ENV, ...REQUIREMENTS.filter((r) => existsSync(join(src, r))).flatMap((r) => ['--with-requirements', r])]
  const checker = typed(src)
  return [
    { script: 'lint', bin: 'uv', args: [...env, 'ruff', 'check', ...py], dir: '' },
    ...(checker === null ? [] : [{ script: 'typecheck', bin: 'uv', args: [...env, ...checker, ...py], dir: '' }]),
    { script: 'test', bin: 'uv', args: [...env, 'python', '-m', 'pytest'], dir: '' },
  ]
}

const PROJECT = [
  { script: 'install', bin: 'uv', args: ['sync', '--all-extras'] },
  { script: 'lint', bin: 'uv', args: ['tool', 'run', 'ruff', 'check'] },
  { script: 'typecheck', bin: 'uv', args: ['run', '--with', 'pyright', 'pyright'] },
  { script: 'test', bin: 'uv', args: ['run', '--no-sync', 'pytest'] },
]

/** Our own repo's gates in each folder short of the root whose `pyproject.toml` is nearest a touched `.py`. */
export function subprojects(src: string, touched: string[]): Gate[] {
  const dirs = new Set(touched.filter((f) => f.endsWith('.py') && existsSync(join(src, f))).flatMap((f) => project(src, f) ?? []))
  return [...dirs].flatMap((dir) => PROJECT.map((g) => ({ ...g, dir })))
}

/** Every touched path, Markdown outside `rules/` and `schema/` aside, sits in a folder `subprojects()` gates. */
export function contained(src: string, touched: string[]): boolean {
  const dirs = subprojects(src, touched).map((g) => g.dir)
  return dirs.length > 0 && touched.every((f) => dirs.some((d) => f.startsWith(`${d}/`)) || (f.endsWith('.md') && !/^(rules|schema)\//.test(f)))
}

function project(src: string, file: string): string | null {
  for (let dir = dirname(file); dir !== '.'; dir = dirname(dir)) {
    if (existsSync(join(src, dir, 'pyproject.toml'))) return dir
  }
  return null
}

function typed(src: string): string[] | null {
  if (existsSync(join(src, 'pyrightconfig.json'))) return ['pyright']
  const cfg = join(src, 'setup.cfg')
  const mypy = ['mypy.ini', '.mypy.ini'].some((f) => existsSync(join(src, f))) || (existsSync(cfg) && /^\[mypy\]\s*$/m.test(readFileSync(cfg, 'utf8')))
  return mypy ? ['--with', 'mypy', 'mypy'] : null
}
