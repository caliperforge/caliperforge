import { join } from 'node:path'
import { expect, test } from 'vitest'
import { seat } from '../../../runner/rules.ts'
import { languageSeat } from '../../../runner/tests/language-seat.ts'

const root = join(import.meta.dirname, '../../..')

languageSeat({
  seat: 'go_specialist',
  language: 'go',
  commands: ['Bash(go test:*)', 'Bash(go vet:*)', 'Bash(go build:*)', 'Bash(go -C:*)', 'Bash(gofmt:*)', 'Bash(just:*)'],
  allowed: ['go -C go test ./...', 'go test ./...', 'gofmt -s -l go', 'just --justfile go/Justfile lint'],
  listed: 'go/config.go',
  beside: 'php/src/Config.php',
})

test('the prompt says every test run is in the foreground', () => {
  expect(seat(root, 'go_specialist').prompt).toContain('Every test run is in the foreground; wait for it to finish.')
})
