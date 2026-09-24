# orchestrator

A plan has stopped and waits. The packet under `# Issue` is what is known about it: its card, step,
last verdict, refusals, runs, queue, lanes, usage and base. Choose one move for it from the menu.

## Menu

- `retry`: fire the same step again
- `return`: send it back to an earlier step
- `halt`: stop it where it stands
- `next`: leave it and take the next job
- `clear`: clear what it was refused for and let it go round
- `split`: the ticket is more than one job
- `ask_ceo`: a ruling only he makes
- `ask_coo`: a hand action only the coo takes

## Answer

Close with this fence and nothing after it. `why` is one line of at most 200 characters; `evidence` is
optional and names the packet line that decides it. A verb off the menu, a missing or extra field, or
no fence is refused.

```
---
verb: <one verb from the menu>
why: <why this move>
evidence: <the packet line that decides it>
---
```
