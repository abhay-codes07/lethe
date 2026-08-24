---
name: identity-resolution
description: Expanding one verified identifier into every handle a person is stored under, and deciding which links are strong enough to erase against. Use at the start of discovery, and whenever a candidate identifier is found in a new system.
---

# Resolving one person across systems

An erasure request arrives with one identifier — usually an email address.
The data sits under many: a user id in the primary database, a customer id in
billing, document ids in a vector index, a device id in analytics. Erasing
only what the seed matches leaves most of the person behind, and looks
complete while doing it.

## Expand outwards, and record every hop

Start from the seed and follow the joins. For every identifier you derive,
record three things: the identifier, the identifier you reached it *from*,
and the rule that connects them — `users.email = $1 -> users.id`, not
"looked it up".

The record is not bookkeeping. When a finding is challenged — "why do you
believe this row is theirs?" — the answer is the chain from the seed to the
identifier that matched it, and a chain with an unexplained hop proves
nothing.

## Grade every link

- **certain** — a unique key or foreign key. The database enforces the link.
- **probable** — strong but unenforced: an exact match on a normalised email,
  a billing id stored in a user column by convention.
- **possible** — a heuristic: shared device, similar name, matching postcode.

Only **certain** links may be erased against without confirmation. For
anything weaker, ask — one question, stating both sides plainly: "an account
`bram.o@example.invalid` shares a device id with the subject. Same person, or
a different one?"

The cost of a wrong link is not a missed row. It is erasing a different
person's data, which is a new breach committed while remedying nothing.

## Where second identities hide

- **Alias emails.** Plus-addressing and dots: `ada+shop@` and `ada@` are the
  same inbox. Normalise before matching; report the normalisation as the rule.
- **Merged and duplicate accounts.** A support-desk merge leaves the old
  account id live in old rows.
- **Free-text and JSON columns.** A name or email inside a `properties` blob
  joins to nothing; search for the literal values of every identifier you
  hold, in every text-bearing column.
- **Third-party ids.** Payment processors and support desks assign their own
  ids; the link lives in whichever column the integration wrote it to.

## What not to do

Never invent an identifier. Every identifier you act on must be the seed or
derived from it by a stated rule — an identifier with no chain is somebody
else's. Never promote a link's grade because the sweep would be tidier; the
grade describes the evidence, not the convenience.
