import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { git } from '../sequencer/workspace.ts'

/** Copies `src/<suite>` to `into`, and an untracked foundry.toml with lib/forge-std to `into/root/`, which run_pair copies onto each checkout's root. */
export function rooted(src: string, suite: string, into: string): void {
  cpSync(join(src, suite), into, { recursive: true })
  if (!existsSync(join(src, 'foundry.toml')) || git(src, ['ls-files', 'foundry.toml']).trim() !== '') return
  mkdirSync(join(into, 'root'), { recursive: true })
  cpSync(join(src, 'foundry.toml'), join(into, 'root/foundry.toml'))
  if (existsSync(join(src, 'lib/forge-std'))) cpSync(join(src, 'lib/forge-std'), join(into, 'root/lib/forge-std'), { recursive: true })
}
