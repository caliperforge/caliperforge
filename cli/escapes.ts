export function escapeSection(rows: { repo: string; number: number; escapes: number }[]): string {
  const lines = rows.map((r, i) => (rows[i - 1]?.repo === r.repo ? '' : `  ${r.repo}\n`) +
    `    #${String(r.number)}\t${String(r.escapes)} escape(s)\n`)
  return `escapes per outside PR by repo, last 7 d (${String(rows.length)})\n${rows.length === 0 ? '  none\n' : lines.join('')}`
}
