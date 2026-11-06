import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Run } from './checks.ts'
import type { Gate } from './gates.ts'
import { git } from './workspace.ts'

const PROBLEM = /^(error|warn)\s+(.+)$/

const FILE = /^\s*File:\s*(.+)$/

/** The head's SUSHI errors and warnings beyond those the run at `gate.base` printed; null where nothing was re-run. */
export function fresh(src: string, gate: Gate, output: string, run: Run, said?: (line: string) => void): string[] | null {
  const head = problems(output, join(src, gate.dir))
  const base = gate.base
  if (base === undefined || head.length === 0) return null
  return atBase(src, base, (tree) => {
    const cwd = join(tree, gate.dir)
    const left = new Map<string, number>()
    for (const p of problems(run(gate.args, cwd, gate.bin).output, cwd)) left.set(p, (left.get(p) ?? 0) + 1)
    const extra = head.filter((p) => {
      const n = left.get(p) ?? 0
      left.set(p, n - 1)
      return n <= 0
    })
    if (extra.length === 0) said?.(`sushi: ${String(head.length)} errors and warnings, each already at ${base.slice(0, 12)}`)
    return extra
  })
}

const COMPILE = 'compile_error!'

/** `gate.base`, where a built `cargo test` red on `compile_error!` at the head is red on it there too. */
export function inherited(src: string, gate: Gate, output: string, run: Run): { base?: string } {
  const base = gate.base
  if (gate.bin !== 'cargo' || base === undefined || !output.includes(COMPILE)) return {}
  const ran = atBase(src, base, (tree) => run(gate.args, join(tree, gate.dir), gate.bin))
  return ran !== null && !ran.ok && ran.output.includes(COMPILE) ? { base } : {}
}

/** `use` on a detached worktree of `src` at `base`, removed after; null where the worktree cannot be added. */
function atBase<T>(src: string, base: string, use: (tree: string) => T): T | null {
  // SUSHI prints `File:` under process.cwd(), which resolves macOS's /var symlink.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cf-inherited-')))
  const tree = join(dir, 'tree')
  try {
    if (spawnSync('git', ['worktree', 'add', '--detach', tree, base], { cwd: src, stdio: 'ignore' }).status !== 0) return null
    return use(tree)
  } finally {
    if (existsSync(tree)) git(src, ['worktree', 'remove', '--force', tree])
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Each `error` or `warn` line with its `File:` keyed on the longest trailing part of `File:` that is a file under `cwd`; the `Line:` is dropped, so an edit above it is not new. */
export function problems(output: string, cwd: string): string[] {
  const lines = output.split('\n')
  return lines.flatMap((line, at) => {
    const found = PROBLEM.exec(line.trimEnd())
    if (found === null) return []
    const file = FILE.exec(lines[at + 1] ?? '')?.[1]?.trim()
    return [`${found[1] ?? ''} ${found[2] ?? ''}${file === undefined ? '' : `\n  File: ${keyOf(file, cwd)}`}`]
  })
}

function keyOf(file: string, cwd: string): string {
  const parts = file.split('/')
  for (let i = 0; i < parts.length; i++) {
    const tail = parts.slice(i)
    if (!tail.includes('..') && statSync(join(cwd, ...tail), { throwIfNoEntry: false })?.isFile() === true) return tail.join('/')
  }
  return file
}
