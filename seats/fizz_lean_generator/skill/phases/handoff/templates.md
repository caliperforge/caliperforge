# Handoff: context

phase: context
next: scaffold
mode: <automatic or guided>
agent_model: <sonnet or opus>

## Reads

- <file under PROJECT_ROOT, with the x-ray section or functions the next phase needs> — <what it reads it for>

# Handoff: scaffold

phase: scaffold
next: coverage

## Reads

- <file under PROJECT_ROOT, with the x-ray section or functions the next phase needs> — <what it reads it for>

## Stand-ins

- <contract> | limits: <the real limits it enforces: share price bounds, virtual shares or offset, max interest per call, who can mint>

# Handoff: coverage

phase: coverage
next: invariants
fuzz_build_cmd: <the command Step 8.0 set>

## Reads

- <file under PROJECT_ROOT, with the x-ray section or functions the next phase needs> — <what it reads it for>

# Handoff: invariants

phase: invariants
next: campaigns

## Reads

- <file under PROJECT_ROOT, with the x-ray section or functions the next phase needs> — <what it reads it for>

## Converted values

- <property> | tolerance: <wei per conversion × conversions>
- <property> | delta: <token>.balanceOf(<holder>)

# Handoff: campaigns

phase: campaigns
next: none
fuzzer: <medusa or echidna>
