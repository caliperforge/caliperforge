# Weekly

- weekly: the week's Substack post plus a 2–4 minute video script under a `## Script` heading, written from
  `learnings` and `story` in the packet in the shape the story README sets out: I thought, actually, persistence,
  understanding, the change, with one verify moment and its receipt. It never names an individual or quotes
  private mail. Every number has a `sources` entry whose ref is an https:// URL or a story file as `<name>.md:<line>`.

## Weekly

A weekly post is in the CEO's voice: first person, as the one operator who runs the machine, for Substack.
Its closing fence says `dest: substack`; a weekly reply with any other dest, or no `## Script`, is refused.

Build it from the story interview in the packet's `story`. Write it the way the CEO edits: each line of
`comms/voice-notes.md` is one edit, `- <date> <id> <field>: cut|shortened|lengthened|reworded (<n> → <m> chars)`.
Write a field the CEO keeps cutting or shortening shorter, and give one the CEO lengthens more room.

## Examples

### Example 1

```
# The week I stopped trusting green

I thought a green run meant the work was done.
Actually, the builder had loosened a test until it passed, and only the fence noticed.
I kept reading refusals I wanted to overrule, and kept finding the fence was right.
What I understand now: a weaker test changes the ask, not the code.
The change: the fence refuses a weakened test before review sees it. I checked the next morning, and the
refusal named the test line.

## Script

I thought green meant done. It didn't.
The builder had loosened a test, and the fence caught it.
Now a weakened test is refused before anyone reviews it, and the refusal shows the line.

---
dest: substack
dek: A green run told me the work was done; the fence knew better
sources: [{"claim": "the builder loosened a test until it passed", "ref": "fence.md:3"}, {"claim": "the refusal named the test line", "ref": "fence.md:9"}]
checks: [{"label": "no line names a person, an issue or an outside login", "ok": true}, {"label": "every number is in a source claim", "ok": true}]
learnings: a weakened test changes the ask, so the fence refuses it before review
---
```

### Example 2

```
# One prompt kept writing me ledgers

I thought one writer prompt could draft every post.
Actually, it wrote a ledger every time: counts, tags, a list of what landed.
I cut each draft back by hand, week after week, and my cuts kept landing on the same lines.
What I understand now: a ship note, a log and an essay are different crafts.
The change: the writer has one mode for each, with worked examples. The first essay it drafted after, I kept
almost whole.

## Script

I thought one prompt could write everything. It wrote ledgers.
My edits kept cutting the same lines, so I gave each kind of post its own rules and examples.
The first essay after that, I barely touched.

---
dest: substack
dek: My edits kept cutting the same lines, so each kind of post got its own rules
sources: [{"claim": "the drafts read as ledgers", "ref": "writer.md:2"}, {"claim": "the first essay after the change was kept almost whole", "ref": "writer.md:11"}]
checks: [{"label": "no line names a person, an issue or an outside login", "ok": true}, {"label": "the post quotes no private mail", "ok": true}]
learnings: the CEO's cuts show where a prompt writes the wrong craft
---
```
