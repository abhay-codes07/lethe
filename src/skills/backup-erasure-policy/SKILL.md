---
name: backup-erasure-policy
description: What to do about data that survives in backup media, which cannot be edited in place. Use when planning any erasure, and when describing to the requester what remains and until when.
---

# Backups hold the data after the erasure

A backup is a point-in-time copy. Removing one person from it means
restoring the whole thing, deleting, and re-imaging — rarely safe, never
routine, and not what regulators actually require.

What they accept is the proportionate approach: the data may survive in
backup media provided it is put **beyond use**. Beyond use is not a mood; it
is four checkable conditions:

1. The data cannot be restored into a live environment.
2. It is not used for any decision affecting the person.
3. The requester is **told** it exists in backups, and roughly when the media
   rotation will genuinely remove it.
4. It is deleted when that rotation happens.

## The suppression ledger is the mechanism

Every erased identifier is recorded on the suppression ledger with the date
its backup media rotates out. Every restore path consults the ledger and
withholds records belonging to suppressed identifiers. That converts an
unprovable claim — "we deleted them from the backups" — into a demonstrable
one: the identifier is on the ledger, the restore checks the ledger, and the
media rotates on a named date.

When planning an erasure:

- **Anonymised findings suppress too.** The live record was severed from the
  subject, but the backup holds the original; an unfiltered restore
  reintroduces the link that was just cut.
- **The rotation date must be real.** It comes from the backup schedule, not
  from optimism. A date that has already passed claims the data is gone while
  the disclosure says it survives — the certificate refuses that
  contradiction.
- **Never report backup copies as erased.** The certificate carries a
  beyond-use section stating what remains, that it cannot re-enter a live
  system, and when it rotates out. Its absence is itself a claim — that no
  backup copies survive — so omit it only when that is true.

## What never happens

- A restore is never run without the ledger. If the ledger cannot be
  consulted, the restore does not proceed: blocking a restore is an
  operational problem, silently reintroducing erased data is a breach.
- A suppression is never lifted casually. Lifting reverses an erasure; it
  requires a person, a reason, and leaves the original entry visible.
- Backup media is never enumerated to the requester. They are told the fact
  and the date, not the topology.
