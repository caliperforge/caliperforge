import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { type AddressInfo, createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { sender } from '../../precedents/mismatch.ts'
import { Cases, probe } from './probe.ts'

process.setUncaughtExceptionCaptureCallback((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
const { values } = parseArgs({ args: process.argv.slice(2), options: { rpc: { type: 'string', default: 'https://api.mainnet-beta.solana.com' },
  cases: { type: 'string', default: join(import.meta.dirname, 'cases.json') } } })
const parsed = Cases.safeParse(JSON.parse(readFileSync(values.cases, 'utf8')))
if (!parsed.success) throw new Error(`${values.cases}: ${z.prettifyError(parsed.error)}`)

const servers = [createServer().listen(0, '127.0.0.1'), createServer().listen(0, '127.0.0.1')] as const
await Promise.all(servers.map((s) => once(s, 'listening')))
const portOf = (s: Server): string => String((s.address() as AddressInfo).port)
const [port, ws] = [portOf(servers[0]), portOf(servers[1])]
for (const s of servers) s.close()

const surfnet = `http://127.0.0.1:${port}`
const healthy = (): Promise<boolean> => sender(surfnet)({ method: 'getHealth', params: [] }).then((r) => 'result' in r && r.result === 'ok', () => false)
const child = spawn('surfpool', ['start', '--no-tui', '--rpc-url', values.rpc, '--port', port, '--ws-port', ws], { stdio: 'ignore' })
try {
  for (const deadline = Date.now() + 60_000; !await healthy();) {
    if (child.exitCode !== null) throw new Error(`surfpool exited with ${String(child.exitCode)} before getHealth answered`)
    if (Date.now() > deadline) throw new Error(`surfpool did not answer getHealth on ${surfnet} within 60 s`)
    await sleep(1000)
  }
  const { rows, matched } = await probe(parsed.data, { real: values.rpc, surfnet }, 200)
  process.stdout.write(`${rows.map((r) => `${r}\n`).join('')}${String(matched)} of ${String(parsed.data.length)} cases match\n`)
} finally {
  child.kill()
}
