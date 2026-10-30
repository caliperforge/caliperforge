# Handoff: context

phase: context
next: scaffold
mode: <automatic or guided>
agent_model: <sonnet or opus>

## Reads

- <file under PROJECT_ROOT, with the x-ray section or functions the next phase needs> — <what it reads it for>

## Signatures

- <Contract.function(params) returns (types)> | at: <file under PROJECT_ROOT> L<start>-L<end>

## Guards

- <Contract.function> | reverts: <each condition and the error it raises> | at: <file under PROJECT_ROOT> L<start>-L<end>

## Roles

- <role, owner or modifier> | holds: <who holds it> | gates: <the functions it gates>

## Limits

- <contract and value> | bound: <the bound the code enforces: cap, max per call, minimum, delay> | at: <file under PROJECT_ROOT> L<start>-L<end>

# Handoff: scaffold

phase: scaffold
next: coverage

## Reads

- <file under PROJECT_ROOT, with the x-ray section or functions the next phase needs> — <what it reads it for>

## Signatures

- <Contract.function(params) returns (types)> | at: <file under PROJECT_ROOT> L<start>-L<end>

## Guards

- <Contract.function> | reverts: <each condition and the error it raises> | at: <file under PROJECT_ROOT> L<start>-L<end>

## Roles

- <role, owner or modifier> | holds: <who holds it> | gates: <the functions it gates>

## Limits

- <contract and value> | bound: <the bound the code enforces: cap, max per call, minimum, delay> | at: <file under PROJECT_ROOT> L<start>-L<end>

## Stand-ins

- <contract> | limits: <the real limits it enforces: share price bounds, virtual shares or offset, max interest per call, who can mint>

# Handoff: coverage

phase: coverage
next: invariants
fuzz_build_cmd: <the command Step 8.0 set>

## Reads

- <file under PROJECT_ROOT, with the x-ray section or functions the next phase needs> — <what it reads it for>

## Signatures

- <Contract.function(params) returns (types)> | at: <file under PROJECT_ROOT> L<start>-L<end>

## Guards

- <Contract.function> | reverts: <each condition and the error it raises> | at: <file under PROJECT_ROOT> L<start>-L<end>

## Roles

- <role, owner or modifier> | holds: <who holds it> | gates: <the functions it gates>

## Limits

- <contract and value> | bound: <the bound the code enforces: cap, max per call, minimum, delay> | at: <file under PROJECT_ROOT> L<start>-L<end>

# Handoff: invariants

phase: invariants
next: campaigns

## Reads

- <file under PROJECT_ROOT, with the x-ray section or functions the next phase needs> — <what it reads it for>

## Signatures

- <Contract.function(params) returns (types)> | at: <file under PROJECT_ROOT> L<start>-L<end>

## Guards

- <Contract.function> | reverts: <each condition and the error it raises> | at: <file under PROJECT_ROOT> L<start>-L<end>

## Roles

- <role, owner or modifier> | holds: <who holds it> | gates: <the functions it gates>

## Limits

- <contract and value> | bound: <the bound the code enforces: cap, max per call, minimum, delay> | at: <file under PROJECT_ROOT> L<start>-L<end>

## Converted values

- <property> | tolerance: <wei per conversion × conversions>
- <property> | delta: <token>.balanceOf(<holder>)

# Handoff: campaigns

phase: campaigns
next: none
fuzzer: <medusa or echidna>
