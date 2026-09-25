import { createHash } from 'node:crypto'
import { failures, type Failure } from '../../sequencer/checks.ts'
import type { Verdict } from '../record.ts'

const NAME = /^[ \t]*(?:FAIL\b|×)[ \t]+(.+?)(?:[ \t]+\d+ms)?[ \t]*$/

export function checked(failed: Failure | null, diff: string): Verdict {
  const subject_digest = createHash('sha256').update(diff).digest('hex')
  if (failed === null) {
    return { outcome: 'pass', defect_class: null, origin_kind: null, origin_ref: null, subject_digest, spans: [], message: 'every script the checkout names exits zero' }
  }
  const refused: Verdict = {
    outcome: 'refuse', defect_class: null,
    origin_kind: 'rail',
    origin_ref: 'checks',
    subject_digest,
    spans: [`checks:${failed.script}`],
    message: `${failed.command} exit ${failed.code}`,
  }
  const test = failed.script === 'test' ? named(failed.output) : null
  // `origin-on-refuse` reads origin_ref off the literal, so a test name can only land over it (checks/origin-on-refuse.ts:56)
  return test === null ? refused : { ...refused, origin_ref: test }
}

function named(output: string): string | null {
  const opener = failures(output)[0]?.split('\n')[0] ?? ''
  return NAME.exec(opener)?.[1] ?? null
}
