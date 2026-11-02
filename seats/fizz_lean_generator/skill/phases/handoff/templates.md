# Map

## Roles

- <role, owner or modifier> | holds: <who holds it> | gates: <the functions it gates> | at: <file under PROJECT_ROOT> L<start>-L<end>

## Guards

- <Contract.function> | reverts: <each condition and the error it raises> | at: <file under PROJECT_ROOT> L<start>-L<end>

## Limits

- <contract and value> | bound: <the bound the code enforces: cap, max per call, minimum, delay> | at: <file under PROJECT_ROOT> L<start>-L<end>

## Outside dependencies

- <oracle, token or strategy> | limits: <the real limits it enforces> | at: <file under PROJECT_ROOT> L<start>-L<end>

## Conversion points

- <Contract.function> | converts: <from what to what, and where it rounds> | at: <file under PROJECT_ROOT> L<start>-L<end>

## Aggregates

- <Contract.variable> | parts: <the parts it should equal> | movers: <each public or external Contract.function that writes it> | at: <file under PROJECT_ROOT> L<start>-L<end>

## Not tracked

- <Contract.function or Contract.variable> | reason: <why no row tracks it>

## Known holes

- <what the suite cannot reach> | reason: <why>

## Skipped entry points

- <Contract.function> | reason: <why it has no handler>

## Unclamped

- <Contract.function> | reason: <why it has no clamped handler>

## Unreachable

- <the ## Reach row's first cell> | reason: <why no input reaches it>

# Candidates

## Candidates

- <id> | says: <plain words> | relies: <map row ids> | reads: <trackers and handlers> | converted: <yes or no> | tolerance: <wei per conversion × conversions> | delta: <token>.balanceOf(<holder>) | fails: <what failure would mean>

# Plan

## Rows

- <id> | says: <plain words> | relies: <map row ids> | reads: <trackers and handlers> | converted: <yes or no> | tolerance: <wei per conversion × conversions> | delta: <token>.balanceOf(<holder>) | fails: <what failure would mean> | implementer: <global or specific>

## Skipped

- <map row id> | reason: <why>

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
