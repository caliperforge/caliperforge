import { resolve } from 'node:path'
import { runAll } from './all.ts'

const [root = '.', only] = process.argv.slice(2)
const findings = await runAll(resolve(root), only)

for (const f of findings) process.stdout.write(`${f.check}\t${f.path}:${String(f.line)}\t${f.message}\n`)
process.stdout.write(`${String(findings.length)} finding(s)\n`)
process.exit(findings.length === 0 ? 0 : 1)
