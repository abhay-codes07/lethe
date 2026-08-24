---
name: vector-index-compaction
description: Why deleting from a vector index does not delete, and what actually removes the data. Use when a finding lives in a vector store, when planning its disposition, and when verifying its erasure.
---

# Deleting from a vector index does not delete

Removing a vector through the store's API typically tombstones it: the entry
stops appearing in search results, and the values stay physically present in
the index files. Anyone with access to the storage layer — a raw disk read, a
copied snapshot — can recover the embedding, and embeddings of text are close
enough to the text to matter. This is a published result, not a hypothetical:
soft-deleted vectors in HNSW indexes remain reconstructible until the index
is rewritten.

A certificate that says "deleted" about a tombstoned vector is false.

## The disposition

Vector findings are always `requires_compaction` durability, and their plan
line is `delete_and_compact`, never plain `delete`. The delete is not
finished until the index has been compacted or rebuilt — treat the two as
one action with two steps, and report completion only after the second.

## Executing

1. Delete the subject's points through the API, by the document ids recorded
   in the finding.
2. Trigger the store's compaction or rebuild for that collection. Where the
   store exposes no compaction call, a rebuild — re-creating the collection
   from the remaining points — is the equivalent.
3. Confirm it ran: check the store's status or version counters, not the
   passage of time.

Report the compaction as its own fact. Verification refuses to certify a
purge whose compaction was never confirmed, and it needs to know which
system's compaction you confirmed.

## Verifying

Search is not sufficient proof: a tombstoned vector is invisible to search,
which is exactly the failure being checked for. Where possible, confirm the
compaction event itself; where only search is available, say so — the
certificate's scope statement exists for honestly-stated limits.

## The wider family

The same delete-does-not-delete shape appears in: append-only logs, object
stores with versioning enabled (the delete writes a marker; old versions
remain), and columnar warehouses with time travel. When a finding lives in
any of these, the question to answer is always the same one: after the
ordinary delete call, can the bytes still be read by any path? If yes, the
finding is `requires_compaction` or `immutable_until_expiry`, and the plan
must say what makes the erasure real.
