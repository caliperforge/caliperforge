# Proposal: caliperforge.com direction

The homepage mockup is `v2/PROPOSAL_2026-10-11_website.html`. Nothing is built until the CEO says yes.

## Positioning

Caliperforge stays a research lab. The lead changes to security and verification for payment systems.

It is for teams that ship payment rails and paid APIs and need them checked end to end: from the offer an
endpoint quotes to the price its listing declares.

Three things we shipped carry the claim, each told as a capability:

- **Paid end-to-end audits.** We pay each endpoint a catalog lists and check its 402 offer, its network,
  its coin and its declared price against what it quotes. The listing is read too: whether its host
  resolves, where it is hosted, what its text claims (`paydesk/assess.ts`, `paydesk/card.ts`).
- **Fixes in payment code.** Where a check finds a fault, we send the fix to the code that owns it.
- **Invariants and regression suites.** We write down what a payment flow must always hold and keep the
  tests that check it on every change.

## Page map

- **Home**: the lead, who it is for, the three capabilities, the newest writing.
- **Work**: each capability in depth: what it checks, how a check runs, what a team receives.
- **Writing**: the blog, dated posts on method and on what checking payment systems teaches, newest first.
- **About**: the lab, why it publishes its method, how to reach it.

## The current site, measured

- **Blog freshness.** The newest live post is dated 2026-08-01, about 10 weeks stale. Folds into writing:
  every post shows its date, and home lists the newest three, so a gap shows on the front page.
- **Hosting from the v1 repo.** The site is served from `site/` in caliperforge/crypto-contributor-org,
  next to 25 unpushed v1 commits, so publishing waits on #1100. Goes: the site moves to caliperforge/site
  (#1102–#1105), and this proposal changes nothing in v1 (`docs/adr/0006-v1-untouched.md`).
- **Pages outside the map.** A page on shipped work folds into work, a page on the lab folds into about,
  and any other goes.

A page-by-page inventory follows in the first build ticket, against caliperforge/site.

## Design note

The site reads like a lab notebook: claims in prose, evidence in monospace, one colour for what was checked.

**Type.** Three system stacks, no web font, so every page loads with nothing fetched.

- Headings: `ui-serif, "Iowan Old Style", Georgia, Cambria, "Times New Roman", serif`. A serif heading
  reads as published research, not a product page.
- Body: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` at 1.0625rem,
  line height 1.6. Plain and fast on every platform.
- Evidence: `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`. What a check
  reads (a status, a field, a price) is set the way it was read.

**Palette.** Paper and ink with one accent, used only on links and evidence.

| Role   | Hex       | Use                                          |
|--------|-----------|----------------------------------------------|
| Paper  | `#f7f5f0` | page ground                                  |
| Ink    | `#16191f` | text, headings                               |
| Muted  | `#5b6170` | dates, captions, secondary text              |
| Rule   | `#d9d4c7` | hairlines between sections and table rows    |
| Panel  | `#eeebe3` | evidence blocks                              |
| Check  | `#1f6f5c` | links and the call to act; evidence markers  |

Ink on paper is 16.2:1 and check on paper 5.5:1, both above WCAG AA.

**Layout.** A 12-column grid, 72rem wide at most, 1.5rem gutters, 2rem page margins.

- Prose runs at most 38rem (about 68 characters), columns 1–8; asides and evidence take columns 9–12.
- The three capabilities sit as three 4-column cards; below 48rem every block stacks to one column.
- Sections are split by a hairline rule and 4rem of space, not by colour bands or images: the page has
  no image, so nothing on it is decoration.
- The nav is four words in the header, left to right in page-map order, the current page underlined.

## Held back

Ludo, the Solana Foundation's gateways and the pay catalog findings stay off every public page until the CEO clears them.
