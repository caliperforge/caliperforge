import { spawn } from 'node:child_process'
import type { Apart } from '../sequencer/index.ts'
import type { Fired } from '../sequencer/kind.ts'

/** The last line `cf lap` writes: what the job fired, for the tick that forked it. */
export const FIRED = 'cf-lap-fired\t'

/**
 * Each leased job runs in a child process, so one job's synchronous checks never freeze another's agent.
 * Each lap leads its own process group, so a signal to the tick's group does not reach it.
 */
export function apart(script: string): Apart {
  return (plan, stole) => new Promise((done, failed) => {
    const args = [...process.execArgv, script, 'lap', String(plan), '--from', String(process.pid),
      ...(stole === null ? [] : ['--stole', String(stole)])]
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'inherit'], detached: true })
    let said = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { said += chunk })
    child.on('error', failed)
    child.on('close', (code) => {
      const last = said.split('\n').findLast((l) => l.startsWith(FIRED))
      if (code === 0 && last !== undefined) done(JSON.parse(last.slice(FIRED.length)) as Fired[])
      else failed(new Error(`cf lap ${String(plan)} exited ${String(code)}`))
    })
  })
}
