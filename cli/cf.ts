#!/usr/bin/env node
import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeAgentSdk } from '../providers/claude-agent-sdk/index.ts'
import { fire } from '../runner/index.ts'
import { dump, migrate, open } from '../store/index.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }

const cf = new Command('cf').version(pkg.version)

cf.command('migrate').action(() => {
  const applied = migrate(open(join(root, 'cf.db')), join(root, 'schema'))
  for (const file of applied) process.stdout.write(`applied ${file}\n`)
})

cf.command('dump').argument('[out]', 'file to write the dump to', 'cf.dump.sql').action((out: string) => {
  const path = resolve(root, out)
  dump(open(join(root, 'cf.db')), path)
  process.stdout.write(`dumped to ${path}\n`)
})

cf.command('runs').action(() => {
  const rows = open(join(root, 'cf.db'))
    .prepare('SELECT id, seat, exit, input_tokens + cache_tokens + output_tokens AS tokens, seconds FROM runs ORDER BY id')
    .all() as { id: number; seat: string; exit: number; tokens: number; seconds: number }[]
  for (const r of rows) process.stdout.write(`${String(r.id)}\t${r.seat}\t${String(r.exit)}\t${String(r.tokens)}\t${r.seconds.toFixed(1)}\n`)
})

cf.command('fire')
  .argument('<seat>')
  .argument('<issue-file>')
  .option('--cwd <dir>', 'checkout the seat writes in', process.cwd())
  .action(async (name: string, issue: string, options: { cwd: string }) => {
    const db = open(join(root, 'cf.db'))
    migrate(db, join(root, 'schema'))
    const run = await fire(db, root, name, resolve(options.cwd), readFileSync(issue, 'utf8'), claudeAgentSdk)
    process.stderr.write(`run ${String(run.id)}\n`)
    process.stdout.write(run.text)
  })

await cf.parseAsync()
