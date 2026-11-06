import { spawn } from 'node:child_process'

const [seconds = '', command = '', ...args] = process.argv.slice(2)
const child = spawn(command, args, { detached: true, stdio: ['ignore', 2, 2] })
const timer = setTimeout(() => {
  process.kill(-Number(child.pid), 'SIGKILL')
  process.exit(124)
}, Number(seconds) * 1000)
child.on('exit', (code) => {
  clearTimeout(timer)
  process.exit(code ?? 1)
})
