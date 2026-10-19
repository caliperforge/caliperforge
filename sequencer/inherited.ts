import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { Run } from './checks.ts'
import type { Gate } from './gates.ts'
import { git } from './workspace.ts'

const PROBLEM = /^(error|warn)\s+(.+)$/

const FILE = /^\s*File:\s*(.+)$/

/** The head's SUSHI errors and warnings beyond those the run at `gate.base` printed; null where nothing was re-run. */
export function fresh(src: string, gate: Gate, output: string, run: Run, said?: (line: string) => void): string[] | null {
  const head = problems(output, join(src, gate.dir))
  if (gate.base === undefined || head.length === 0) return null
  // SUSHI prints `File:` under process.cwd(), which resolves macOS's /var symlink.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cf-inherited-')))
  const tree = join(dir, 'tree')
  try {
    if (spawnSync('git', ['worktree', 'add', '--detach', tree, gate.base], { cwd: src, stdio: 'ignore' }).status !== 0) return null
    const cwd = join(tree, gate.dir)
    const left = new Map<string, number>()
    for (const p of problems(run(gate.args, cwd, gate.bin).output, cwd)) left.set(p, (left.get(p) ?? 0) + 1)
    const extra = head.filter((p) => {
      const n = left.get(p) ?? 0
      left.set(p, n - 1)
      return n <= 0
    })
    if (extra.length === 0) said?.(`sushi: ${String(head.length)} errors and warnings, each already at ${gate.base.slice(0, 12)}`)
    return extra
  } finally {
    if (existsSync(tree)) git(src, ['worktree', 'remove', '--force', tree])
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Each `error` or `warn` line with its `File:` made relative to `cwd`; the `Line:` is dropped, so an edit above it is not new. */
function problems(output: string, cwd: string): string[] {
  const lines = output.split('\n')
  return lines.flatMap((line, at) => {
    const found = PROBLEM.exec(line.trimEnd())
    if (found === null) return []
    const file = FILE.exec(lines[at + 1] ?? '')?.[1]?.trim()
    return [`${found[1] ?? ''} ${found[2] ?? ''}${file === undefined ? '' : `\n  File: ${relative(cwd, file)}`}`]
  })
}
