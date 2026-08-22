---
name: article-17-exemptions
description: When a data subject's erasure request must be refused or narrowed. Use when deciding whether a located record can be deleted, when a deletion would break referential integrity, or when a finding involves financial, published, or special category data.
---

# When erasure must be refused

The right to erasure is not absolute. Deleting everything you are pointed at is
not the safe default — it trades one compliance failure for another, and the
second is harder to explain, because the record you destroyed was evidence
someone was legally required to keep.

Work through this before proposing a disposition for any finding.

## 1. Is there a positive duty to retain?

**Tax and accounting records.** Transaction records supporting a filed return
must be kept for the statutory period. This is the most common exemption and
the one most often missed.

- Cite: GDPR Art.17(3)(b), plus the national retention period.
- Disposition: **anonymise**, not retain. The financial fact must survive; the
  identity attached to it usually need not. Sever the link and keep the row.
- Applies to: invoices, payments, orders, ledger entries, refunds.

**Legal hold or active dispute.** Data relevant to an open claim, chargeback,
or investigation is preserved until the matter closes.

- Cite: GDPR Art.17(3)(e).
- Disposition: **retain** intact. Do not anonymise — the identity is often the
  material fact in dispute.
- If a hold exists, say so plainly in the plan. The requester is entitled to
  know their request was refused and why.

**Published contributions by others.** A review, comment, or forum post
written by another person that mentions the subject is not the subject's to
erase unilaterally.

- Cite: GDPR Art.17(3)(a).
- Disposition: **anonymise** the subject's identity within it where the
  reference is incidental. Escalate where the reference is the substance.

## 2. Would deleting it break something that must not break?

Run this check during simulation, not afterwards.

If a hard delete violates a foreign key, do not cascade and do not force it.
Cascading a delete through a referential graph is how one erasure request
destroys an unrelated part of the business.

- Propose **anonymise** on the referenced row instead, and name the constraint
  that forced the choice.
- State the downstream effect in the plan: how many rows would have been
  orphaned, and what reporting depends on them.

The person approving needs to see that the alternative was considered and why
it was rejected. "Anonymised because `order_items_customer_fk` would orphan 41
order lines" is a decision someone can check. "Anonymised for safety" is not.

## 3. Does a delete actually delete?

Some stores only mark data as removed. Deleting there and reporting the erasure
as complete makes the certificate a false statement.

- **Vector indexes.** Removing a vector from an HNSW index typically tombstones
  it; the values stay physically present in the index files and are
  recoverable outside the API until the index is compacted or rebuilt. Always
  pair the delete with compaction, and do not report completion until
  compaction has run.
- **Append-only and immutable stores.** Object versioning, write-once buckets,
  and audit logs may not support deletion at all. Where the data cannot be
  removed, say so and describe the expiry or key-rotation path instead of
  implying it was erased.
- **Backups and snapshots.** Restoring a backup taken before the erasure
  reintroduces the data. Either the restore path must re-apply outstanding
  erasures, or the backup must age out. Record which applies. This is the most
  commonly unhandled part of an erasure and should never be silently omitted.
- **Derived copies.** Warehouses, materialised views, caches, search indexes,
  and exports each hold their own copy. Deleting the source does not touch
  them.

## 4. Escalate rather than decide

Hand these to a person and do not resolve them by rule:

- **Special category data** under Art.9 — health, biometrics, religion,
  political opinion, sexual orientation, trade union membership. Both deleting
  and keeping carries consequences.
- **Children's data**, where a different standard may apply.
- Any case where two grounds conflict, or where no rule clearly covers the
  finding.

Escalation is a legitimate outcome. Guessing is not.

## Recording the decision

Every refusal or narrowing that reaches the plan must carry:

1. The disposition — `retain` or `anonymise`, never a bare refusal.
2. The provision relied on, in citable form.
3. A plain-English reason a non-lawyer can check.
4. The retention period, where the obligation is bounded.

These appear on the certificate alongside what was deleted. A certificate that
lists only deletions is incomplete: what was kept, and on what authority, is
exactly what a regulator asks about.
