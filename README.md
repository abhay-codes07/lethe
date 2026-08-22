# Lethe

**Prove personal data is gone.**

When someone asks a company to delete their data, the law gives it 30 days to remove every trace. In practice that request lands on one engineer with a checklist, because personal data is never in one place — it is in Postgres, in an S3 export, in Stripe, in the support inbox, in an analytics table, in last night's backup, and increasingly inside a vector index built from a support ticket eight months ago.

Lethe does that job end to end:

1. **Find** every trace of the subject across all connected systems.
2. **Simulate** the deletion against a shadow snapshot and measure exactly what it would break.
3. **Ask** a human to sign off — showing them the measured consequence, not a raw tool call.
4. **Execute** the erasure only after approval.
5. **Prove** it, by re-running discovery against live systems and issuing a signed Certificate of Erasure.

The premise: **erasure is not an action, it is a proof.** Marking a row deleted is not deletion, and "we called the delete API" is not evidence.

---

## Why this can't be a hosted service

Processing an erasure request means reading your customers' personal data. Routing that through a third-party agent runtime makes that vendor a new data processor, triggers a DPA amendment, and — if they are hosted in another jurisdiction — a cross-border transfer assessment.

So Lethe runs entirely on infrastructure you own, against an agent harness you own, with your own model keys. Nothing leaves your perimeter.

---

## Design principles

**The component that finds your data cannot delete it.** Discovery connects to every system with read-only credentials and a read-only toolset. Deletion is not merely gated for the discovery agent — the capability is absent. Writes live in a separate executor whose every destructive tool requires human approval.

**Approval is a briefing, not a button.** Asking a human to approve `delete_user(id=4471)` produces rubber-stamping, because nobody can evaluate a consequence they cannot see. Lethe never requests approval for an action; it requests approval for a consequence it has already measured against a snapshot:

```
ERASURE PLAN — subject: [redacted], request #DSR-118
Measured against a shadow snapshot. Nothing has been touched.

  DELETE      1,247 rows across 9 tables
  DELETE      3 objects in s3://acme-exports/
  DELETE      1 Stripe customer + 4 payment methods
  PURGE       218 vectors in the support-ticket index
              (requires compaction; soft-delete leaves them recoverable)
  ANONYMISE   orders.customer_id (14 rows)
              hard delete violates order_items_customer_fk and would orphan
              41 order lines. Retained under Art.17(3)(b), tax obligation.

  DRY RUN: 0 constraint violations, 0 traces remaining on snapshot.
```

**Refusing is part of the job.** Some data must legally be retained — tax records, data held for legal claims. An erasure tool that deletes everything it is pointed at is a compliance failure in the other direction. Lethe cites the exemption it is relying on and leaves that data in place.

**Every case is auditable.** The full event history of a request — every query, every finding, the plan, who approved it and when — is replayable, and the certificate is derived from it rather than written alongside it.

---

## Status

Early development. The domain model, agent specifications, and legal rule packs are landing first; connectors and the simulation harness follow.

## Repository layout

```
src/
  agents/      agent specifications — capability separation lives here
  domain/      subjects, findings, erasure plans, certificates
  skills/      instruction packs the agent loads on demand
```

## Development

```bash
npm install
npm run typecheck
npm test
```

Requires Node 20+.

## License

MIT — see [LICENSE](LICENSE).
