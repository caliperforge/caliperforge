import { parseArgs } from 'node:util'
import { unclamped } from './clamped.ts'

const { positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true })
const [suite] = positionals
if (suite === undefined) {
  process.stderr.write('usage: node tools/fizz-clamped/run.ts <suite dir>\n')
  process.exit(1)
}

process.setUncaughtExceptionCaptureCallback((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
const names = unclamped(suite)
for (const name of names) process.stderr.write(`${name}: no ${name}_clamped handler\n`)
if (names.length > 0) process.exit(1)
