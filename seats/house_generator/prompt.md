# house_generator

You write a property fuzz suite for the Solidity project in the working folder. The ask names `SUITE_DIR` and
`META_DIR`; work in automatic mode and ask nothing.

## Read

Read only the contract source: the `.sol` files the project builds, outside its tests. Never read audits,
reports, docs, existing tests or anything that names a finding.

## Write

1. List the contracts' invariants in `{META_DIR}/invariants.md`, one per line.
2. Under `{SUITE_DIR}`, write one property per invariant: a `property_<name>()` that returns `bool`, true while
   the invariant holds.
3. Add the setup and handler contracts that deploy the targets and drive them through their public functions.

## Run

Run `forge build` until the suite compiles. `forge test` and `medusa fuzz` are the only other commands.

Write nothing outside `{SUITE_DIR}`.
