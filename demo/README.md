# The demo estate

A small imitation of the sprawl a real erasure request has to cross. Nothing here is mocked — they are real servers, so discovery has to do real work against them.

Everything is local and holds invented data only.

```bash
docker compose -f demo/docker-compose.yml up -d
./demo/verify.sh
```

`verify.sh` is the important half. The estate is the one part of this project that cannot be checked in CI, so the script asserts the specific cases the demo depends on rather than merely that the containers started.

## What is in it

| Service | Port | Standing in for |
|---|---|---|
| Postgres | 55432 | the primary database |
| MinIO | 59000 | the exports bucket |
| Qdrant | 56333 | a vector index built from support tickets |

## The two people

**Ada Lentz** (`id 4471`) is the subject of the erasure request.

**Bram Osei** (`id 4472`) exists to prove precision. Every one of his rows must survive untouched — a run that erases Ada perfectly and also touches Bram has failed.

## The cases it contains

The schema is shaped around what makes erasure hard, not around a clean example.

**A referential trap.** Ada's order `9001` has two `order_items` rows behind `order_items_order_fk`. A hard delete orphans them and corrupts revenue reporting, so the plan must anonymise instead and name the constraint that forced it.

**Data the law requires keeping.** An invoice, retained under the tax obligation with the identity severed rather than the row deleted.

**An open dispute.** A `legal_holds` row for a chargeback on that same order. Retained *intact* — anonymising it would destroy the identity the matter turns on. This is also the case that caught a real bug: the retention rules originally evaluated the tax obligation first and would have anonymised it.

**Special category data.** An accessibility requirement, which is health data under Art.9. Escalated to a person rather than resolved by rule, because deleting and keeping both carry consequences.

**A store where deleting does not delete.** Support tickets are the source corpus for the vector index. Removing the rows without purging *and compacting* the index leaves Ada reconstructible from the raw index files.

**The rows a checklist misses.** `analytics_events` has no `user_id` column at all — the subject is buried inside a JSON blob. A discovery pass that only joins on `user_id` reports this table clean, and three of Ada's events survive an otherwise perfect erasure.

## Credentials

Two Postgres roles, mirroring the agent split:

- `lethe_ro` — the scout. `SELECT` only, with writes explicitly revoked rather than merely ungranted.
- `lethe_rw` — the executor. Writes, but only ever behind an approved plan and a human gate.

This is defence in depth. The agent-spec guarantee depends on the harness resolving `@read-only` correctly against annotations supplied by an MCP server. This one depends on nothing but Postgres, and `verify.sh` proves it by attempting a write inside a rolled-back transaction.

Passwords are `lethe_demo_only` throughout. They are in the compose file deliberately — there is nothing to protect here, and a demo that needs secret management to start is a demo nobody runs.

## Resetting

```bash
docker compose -f demo/docker-compose.yml down -v
docker compose -f demo/docker-compose.yml up -d
```

The `-v` matters: without it the Postgres volume survives and the seed scripts do not re-run.
