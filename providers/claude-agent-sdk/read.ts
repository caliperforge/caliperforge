import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { Miss, Packet, Range } from '../kind.ts'

const MARGIN = 20

/**
 * The tick runs from a worktree whose `.cf` is a symlink, so a seat's cwd and the paths it reads can name
 * one checkout two ways. Both sides are compared as the disk resolves them; a path not yet on disk
 * resolves through its nearest existing parent.
 */
export function real(path: string): string {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  return parent === path ? path : join(real(parent), basename(path))
}

export function judged(map: NonNullable<Packet['map']>, cwd: string, tool: string, args: unknown): Miss | null {
  const given = args as { file_path?: unknown; offset?: unknown; limit?: unknown }
  if (tool !== 'Read' || typeof given.file_path !== 'string') return null
  const file = relative(real(resolve(cwd)), real(resolve(cwd, given.file_path)))
  if (!/^(?:src|lib)\/.*\.sol$/.test(file)) return null
  const start = typeof given.offset === 'number' ? given.offset : 1
  if (typeof given.limit !== 'number') return { kind: 'read.map_miss', file, lines: `L${String(start)}-end` }
  const end = start + given.limit - 1
  const lines = `L${String(start)}-L${String(end)}`
  const inside = (ranges: Range[]): boolean => ranges.some((r) => r.file === file && start >= r.start - MARGIN && end <= r.end + MARGIN)
  if (!inside(map.ranges)) return { kind: 'read.map_miss', file, lines }
  return inside(map.slice) ? null : { kind: 'read.slice_miss', file, lines }
}
