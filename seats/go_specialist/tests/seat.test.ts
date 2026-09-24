import { languageSeat } from '../../../runner/tests/language-seat.ts'

languageSeat({
  seat: 'go_specialist',
  language: 'go',
  commands: ['Bash(go test:*)', 'Bash(go vet:*)', 'Bash(go build:*)', 'Bash(go -C:*)', 'Bash(gofmt:*)', 'Bash(just:*)'],
  allowed: ['go -C go test ./...', 'go test ./...', 'gofmt -s -l go', 'just --justfile go/Justfile lint'],
  listed: 'go/config.go',
  beside: 'php/src/Config.php',
})
