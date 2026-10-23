import { createHash } from 'node:crypto'
import { parse, type FileDiff } from '../rails/diff.ts'

export const INLINE = 64 * 1024

/** A diff for a prompt: each file's part over `INLINE` bytes becomes one line naming it, so one data file cannot fill the window. */
export function inlined(diff: string): string {
  return sections(diff).map((section) => {
    const file = Buffer.byteLength(section, 'utf8') > INLINE ? parse(section)[0] : undefined
    return file === undefined ? section : summary(section, file)
  }).join('\n')
}

function sections(diff: string): string[] {
  const lines = diff.split('\n')
  const git = lines.some((l) => l.startsWith('diff --git '))
  const starts = lines.flatMap((line, i) => {
    const opens = git ? line.startsWith('diff --git ') : line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')
    return i === 0 || opens ? [i] : []
  })
  return starts.map((from, k) => lines.slice(from, starts[k + 1]).join('\n'))
}

function summary(section: string, file: FileDiff): string {
  const bytes = Buffer.byteLength(section, 'utf8')
  const sha = createHash('sha256').update(section).digest('hex')
  return `# ${file.path} not inlined: ${String(bytes)} bytes, +${String(file.added.length)} -${String(file.removed.length)} lines, sha256 ${sha}; read it in the checkout`
}
