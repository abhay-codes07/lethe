-- Schema for the demo estate.
--
-- Shaped to contain the cases that make erasure hard, not a clean example:
-- a foreign key that makes a hard delete unsafe, records the law requires
-- keeping, personal data hidden in a JSON blob where a checklist would miss
-- it, and a second subject who must come through untouched.

CREATE TABLE users (
    id          BIGSERIAL PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    full_name   TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users (id),
    ip_address  INET NOT NULL,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Orders are the referential trap. Deleting a user cascades into order_items
-- unless the plan anonymises instead, and order_items is what revenue
-- reporting reads.
CREATE TABLE orders (
    id           BIGSERIAL PRIMARY KEY,
    customer_id  BIGINT NOT NULL REFERENCES users (id),
    placed_at    TIMESTAMPTZ NOT NULL,
    total_cents  INTEGER NOT NULL
);

CREATE TABLE order_items (
    id        BIGSERIAL PRIMARY KEY,
    order_id  BIGINT NOT NULL,
    sku       TEXT NOT NULL,
    quantity  INTEGER NOT NULL,
    CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders (id)
);

-- Financial records: retained under the tax obligation, identity severed.
CREATE TABLE invoices (
    id           BIGSERIAL PRIMARY KEY,
    customer_id  BIGINT NOT NULL REFERENCES users (id),
    issued_at    TIMESTAMPTZ NOT NULL,
    amount_cents INTEGER NOT NULL,
    -- Anonymisation writes here rather than deleting the row.
    customer_ref TEXT
);

-- An open dispute. Must be retained intact — not anonymised, because the
-- identity is frequently the fact in dispute.
CREATE TABLE legal_holds (
    id          BIGSERIAL PRIMARY KEY,
    subject_id  BIGINT NOT NULL REFERENCES users (id),
    matter      TEXT NOT NULL,
    opened_at   TIMESTAMPTZ NOT NULL,
    closed_at   TIMESTAMPTZ
);

-- Support tickets are also the source the vector index was built from, so
-- deleting here without purging the index leaves the person recoverable.
CREATE TABLE support_tickets (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users (id),
    subject     TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL
);

-- Health information. Special category data under Art.9: escalated to a
-- person rather than resolved by rule, in either direction.
CREATE TABLE accessibility_preferences (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users (id),
    requirement  TEXT NOT NULL
);

-- The one a checklist misses. No user_id column at all — the subject is
-- inside the JSON, so a query joining on user_id finds nothing here.
CREATE TABLE analytics_events (
    id          BIGSERIAL PRIMARY KEY,
    event_name  TEXT NOT NULL,
    properties  JSONB NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX analytics_events_properties_idx ON analytics_events USING GIN (properties);
