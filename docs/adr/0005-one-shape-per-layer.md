# ADR 0005 — One shape per layer

Status: accepted · 2026-09-16 · BUILD_MAP rev 6, law 5

## Context
A check that goes dark when the layer under it changes still reports green. This is the
mechgreen class: the most expensive failure v1 produced, because it is silent.

## Decision
Adding a seat, review, rail, provider or workflow is one directory with the same manifest,
code and tests. A rail plugs into one interface and is registered in the sequencer's rail
list. Registration and existence are checked against each other, not assumed.

## Enforcement
- `checks/reachability`: every directory under `rails/` is registered in the sequencer's rail
  list, and every registered rail exists. An orphan either way is red.
- `checks/fixture-per-rail`: a rail whose fixture does not fail against it is red — a rail
  that went green on its own war story is caught.
- `checks/template-validity`: a template step naming a seat absent from the roster is red.
