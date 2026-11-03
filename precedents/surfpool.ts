import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const URL = 'http://127.0.0.1:8899'

const DEADLINE = 60_000

const healthy = (): Promise<boolean> => fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] }) })
  .then((r) => r.json()).then((b) => (b as { result?: unknown }).result === 'ok', () => false)

export async function started(checkout: string, rpc: string): Promise<{ url: string; stop: () => void }> {
  execFileSync('cargo', ['build', '--release', '--bin', 'surfpool'], { cwd: checkout })
  const child = spawn(join(checkout, 'target/release/surfpool'), ['start', '--no-tui', '--no-deploy', '-u', rpc], { cwd: checkout, stdio: 'ignore' })
  const run = { exited: false }
  for (const event of ['exit', 'error']) child.once(event, () => { run.exited = true })
  const stop = (): void => { child.kill() }
  for (const deadline = Date.now() + DEADLINE; !run.exited && Date.now() < deadline;) {
    if (await healthy()) return { url: URL, stop }
    await sleep(1000)
  }
  stop()
  throw new Error(run.exited ? `surfpool from ${checkout} exited before getHealth answered`
    : `surfpool from ${checkout} did not answer getHealth within 60 s`)
}
