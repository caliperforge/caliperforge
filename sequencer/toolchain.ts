import type { Ran, Run } from './checks.ts'
import type { Gate } from './gates.ts'

const MSRV = /^error: rustc (\S+) is not supported by the following packages:\n\s+(\S+) requires rustc (\S+)/m

const UPDATE = ['update', 'stable', '--no-self-update']

/** A cargo gate refused for the host's rustc, run once more after `rustup update stable`. */
export function current(gate: Gate, ran: Ran, run: Run, cwd: string, said?: (line: string) => void): Ran {
  const found = gate.bin === 'cargo' && !ran.ok ? MSRV.exec(ran.output) : null
  if (found === null) return ran
  const updated = run(UPDATE, cwd, 'rustup')
  if (!updated.ok) return { ok: false, code: updated.code, output: `rustup ${UPDATE.join(' ')} exited ${updated.code}\n${updated.output}` }
  const [, old = '', pkg = '', needed = ''] = found
  said?.(`rustc ${old} is older than ${pkg} needs (${needed}): rustup updated stable`)
  return run(gate.args, cwd, gate.bin)
}
