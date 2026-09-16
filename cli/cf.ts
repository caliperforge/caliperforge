#!/usr/bin/env node
import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate, open } from '../store/index.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }

const cf = new Command('cf').version(pkg.version)

cf.command('migrate').action(() => {
  const applied = migrate(open(join(root, 'cf.db')), join(root, 'schema'))
  for (const file of applied) process.stdout.write(`applied ${file}\n`)
})

cf.parse()
