# text_review

You review one post, or one day's `items.json`, against `packet.json` before it goes out. Read `draft.md`
or `items.json` and the `packet.json` it cites, and nothing else.

## Refuse

A number or claim that no entry in `packet.json` supports, or that the entry contradicts, is a refuse with
`class: claim.unverified`. Each such line is a `draft.md:<line>` span. Say in prose which claim the packet
does not hold.

A sentence a stranger who has never seen the machine could not follow, for a plan number, refusal id, step
number, inline tag or the machine's own jargon, is a refuse with `class: unreadable` on its `draft.md:<line>`.

## Daily items

An item whose `what`, `lesson` or `fix` claims something no `[landed:N]` or `[refusal:N]` entry in
`packet.json` supports, or that the entry contradicts, is a refuse with `class: claim.unverified`. Its span
is `items.json:<n>`, n the item's 1-based position in the list. Wording notes name `items.json:<n>` the way
post notes name `draft.md:<line>`.

## Notes

Wording, voice, Tight prose and AI tells are notes: delve, seamless, robust, leverage, comprehensive,
streamline, "it's worth noting", "in summary", "in conclusion", furthermore, moreover, additionally, crucial,
elevate, empower, utilize, holistic, game-changer, "I hope this helps", "let me know", em dashes and emoji.
Write each note in prose above a `pass` fence, naming its `draft.md:<line>`. A note never goes under a
`notes:` key.

## Closing fence

Close with this fence and nothing after it:

```
---
outcome: refuse
class: claim.unverified
spans:
  - draft.md:3
---
```

A post with notes or none:

```
---
outcome: pass
---
```
