import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

function typed(src: string): string[] | null {
  if (existsSync(join(src, 'pyrightconfig.json'))) return ['pyright']
  const cfg = join(src, 'setup.cfg')
  const mypy = ['mypy.ini', '.mypy.ini'].some((f) => existsSync(join(src, f))) || (existsSync(cfg) && /^\[mypy\]\s*$/m.test(readFileSync(cfg, 'utf8')))
  return mypy ? ['--with', 'mypy', 'mypy'] : null
}
