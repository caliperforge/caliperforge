import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, test } from 'vitest'
import { alive } from '../../store/leases.ts'
import { apart } from '../apart.ts'

const APART = new URL('../apart.ts', import.meta.url).href

function script(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'cf-apart-')), 'lap.mjs')
  writeFileSync(path, body)
  return path
}

test('a signal to the tick group leaves its laps running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-apart-'))
  const lap = join(dir, 'lap.mjs')
  writeFileSync(lap, `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(dir)} + '/' + process.argv[3], String(process.pid))
setInterval(() => {}, 1000)
`)
  const ticker = join(dir, 'tick.mjs')
  writeFileSync(ticker, `import { apart } from ${JSON.stringify(APART)}
const each = apart(${JSON.stringify(lap)})
each(1, null).catch(() => {})
each(2, null).catch(() => {})
`)
  const tick = spawn(process.execPath, [ticker], { detached: true, stdio: 'ignore' })
  const pids: number[] = []
  try {
    for (let at = 0; at < 200 && !['1', '2'].every((p) => existsSync(join(dir, p))); at += 1) await sleep(50)
    pids.push(...['1', '2'].map((p) => Number(readFileSync(join(dir, p), 'utf8'))))
    const exited = once(tick, 'exit')
    process.kill(-Number(tick.pid), 'SIGTERM')
    await exited
    expect(pids.map(alive)).toEqual([true, true])
  } finally {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
})

test('a lap that exits 0 resolves to what it fired', async () => {
  await expect(apart(script("process.stdout.write('cf-lap-fired\\t[]\\n')"))(1, null)).resolves.toEqual([])
})

test('a lap that exits non-zero is refused', async () => {
  await expect(apart(script('process.exit(3)'))(1, null)).rejects.toThrow('cf lap 1 exited 3')
})
