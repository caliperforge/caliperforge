import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { gate } from '../../providers/claude-agent-sdk/index.ts'
import type { Packet } from '../../providers/kind.ts'
import { authority } from '../../rails/authority/index.ts'
import { packet } from '../index.ts'
import { Seat, rules, seat } from '../rules.ts'
import { record } from '../../store/files.ts'
import { BRIEF_FILES, fenceFor } from '../../sequencer/route.ts'
import { builder } from '../../templates/pr-path.ts'

const root = join(import.meta.dirname, '../..')

/** One language builder on a stranger's repository: what each of the six seats' tests pin, told once. */
export interface LanguageSeat {
  seat: string
  language: string
  commands: string[]
  /** Commands the seat runs before it hands back; each must pass the gate. */
  allowed: string[]
  /** A file the brief lists, and one beside it the brief does not. */
  listed: string
  beside: string
}

const hunk = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n+x\n`

const ran = (p: Packet, command: string) =>
  gate(p, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } } as never)

export function languageSeat(s: LanguageSeat): void {
  declared(s)
  enforced(s)
}

/** What the seat's files say: manifest, roster row, prompt lines, and the language that picks it. */
function declared(s: LanguageSeat): void {
  test('the manifest declares seat, model, effort, tools and the brief-files fence', () => {
    expect(Seat.parse(seat(root, s.seat).manifest)).toMatchObject({
      seat: s.seat,
      model: 'claude-opus-5-5',
      effort: 'high',
      tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', ...s.commands],
      write_paths: [BRIEF_FILES],
    })
  })

  test('the roster carries the seat and the loader gives it a rules row', () => {
    expect(rules(root).find((r) => r.id === s.seat)).toMatchObject({ kind: 'card', path: 'rules/roster.yaml' })
  })

  test('the prompt closes with the handback fence and the rebuild line', () => {
    const prompt = seat(root, s.seat).prompt
    expect(prompt).toContain('- id: D1')
    expect(prompt).toContain(
      "A rebuild's fence lists every case again: carry forward the rows the refusal did not touch, update the ones it did.",
    )
    expect(prompt).toContain('follow it under `# The files`')
  })

  test('the prompt carries their-repo, format-before-handback and parity', () => {
    const prompt = seat(root, s.seat).prompt.replace(/\s+/g, ' ')
    expect(prompt).toContain('Match their repository, not ours')
    expect(prompt).toContain('run their tests and their lint and format check, and say what each returned')
    expect(prompt).toContain('When the brief names a reference implementation, check each input rule against it')
    expect(prompt).toContain('change the value and keep every other word')
  })

  test('the language picks this seat', () => {
    expect(builder(s.language)).toBe(s.seat)
  })

}

/** What the kernel holds the seat to: the command gate and the brief-files fence. */
function enforced(s: LanguageSeat): void {
  test('its own commands pass the gate; anything else, chained or redirected, is refused', () => {
    const { manifest, prompt } = seat(root, s.seat)
    const p = packet(manifest, prompt, '', '', root, join(root, 'x.transcript.jsonl'))
    for (const command of s.allowed) expect(ran(p, command)).toEqual({ continue: true })
    const first = s.allowed[0] ?? ''
    for (const command of ['curl https://example.com', 'git push origin HEAD', `${first} && curl x`, `${first} > ../../base.sha`, `${first} | tee out`]) {
      expect(ran(p, command)).toMatchObject({
        continue: true,
        hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: `ruling:seat.tools refuses the command ${JSON.stringify(command)}` },
      })
    }
  })

  test('the fence is the brief\'s files, and the authority rail refuses a diff beside them', () => {
    const db = fresh(join(root, 'schema'))
    db.prepare(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
      open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
      VALUES (1, 'acme/kit', '2026-09-24', 2, 1, '2026-09-24', 3, 4, 'warm', 'https://github.com/acme/kit')`).run()
    db.prepare(`INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
      VALUES (1, 1, 'acme/kit', 1, 'ludo', 'ready', '2026-09-24', 'https://github.com/acme/kit/issues/1')`).run()
    db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at) VALUES (1, 1, 1, 'pr_path', 'running', '2026-09-24')`).run()
    record(db, 1, [{ path: s.listed, is_new: false }])
    const fence = fenceFor(db, 1, seat(root, s.seat).manifest.write_paths)
    expect(fence).toEqual([s.listed])
    expect(authority(root, s.seat, hunk(s.listed), false, fence)).toMatchObject({ outcome: 'pass' })
    expect(authority(root, s.seat, hunk(s.beside), false, fence))
      .toMatchObject({ outcome: 'refuse', origin_ref: 'authority', spans: [`${s.beside}:1 authority.write_paths`] })
  })
}
