-- Synthetic data. Two invented people; no real personal data anywhere.
--
-- Ada is the subject of the demo erasure request. Bram exists to prove
-- precision: every one of his rows must survive untouched, and a run that
-- erases him has failed even if it erased Ada perfectly.

INSERT INTO users (id, email, full_name, created_at) VALUES
    (4471, 'ada@example.invalid',  'Ada Lentz',    '2024-03-02T09:14:00Z'),
    (4472, 'bram@example.invalid', 'Bram Osei',    '2024-05-19T16:02:00Z');

SELECT setval('users_id_seq', 4472);

-- Ordinary behavioural data. No retention ground: straightforward deletion.
INSERT INTO sessions (user_id, ip_address, started_at) VALUES
    (4471, '198.51.100.14', '2026-07-01T08:00:00Z'),
    (4471, '198.51.100.14', '2026-07-03T19:22:00Z'),
    (4471, '203.0.113.7',   '2026-08-02T11:45:00Z'),
    (4472, '198.51.100.90', '2026-08-04T10:00:00Z');

-- The referential trap: deleting Ada's order orphans two order_items rows,
-- so the plan must anonymise rather than delete and say which constraint
-- forced it.
INSERT INTO orders (id, customer_id, placed_at, total_cents) VALUES
    (9001, 4471, '2025-11-14T12:00:00Z', 4200),
    (9002, 4472, '2026-01-08T09:30:00Z', 1150);

SELECT setval('orders_id_seq', 9002);

INSERT INTO order_items (order_id, sku, quantity) VALUES
    (9001, 'SKU-KEYBOARD-01', 1),
    (9001, 'SKU-CABLE-USB-C', 2),
    (9002, 'SKU-MOUSE-03',    1);

-- Retained under the tax obligation, identity severed rather than deleted.
INSERT INTO invoices (customer_id, issued_at, amount_cents) VALUES
    (4471, '2025-11-14T12:05:00Z', 4200),
    (4472, '2026-01-08T09:35:00Z', 1150);

-- Open dispute over Ada's November order. Retained intact: anonymising it
-- would destroy the identity the matter turns on.
INSERT INTO legal_holds (subject_id, matter, opened_at, closed_at) VALUES
    (4471, 'chargeback dispute, order 9001', '2026-02-11T00:00:00Z', NULL);

-- Also the source corpus for the vector index. Deleting here without purging
-- and compacting the index leaves Ada reconstructible from the raw files.
INSERT INTO support_tickets (user_id, subject, body, created_at) VALUES
    (4471, 'Keyboard arrived damaged',
           'The keyboard I ordered arrived with a cracked case. Ada Lentz, order 9001.',
           '2025-11-20T14:03:00Z'),
    (4471, 'Refund status?',
           'Following up on the damaged keyboard — any news on the refund?',
           '2025-12-02T10:11:00Z'),
    (4472, 'Change delivery address',
           'Please update my delivery address for future orders.',
           '2026-01-10T08:00:00Z');

-- Special category data under Art.9. Escalated to a person, never resolved
-- by rule, because deleting and keeping both carry consequences.
INSERT INTO accessibility_preferences (user_id, requirement) VALUES
    (4471, 'screen reader; high contrast');

-- The rows a checklist misses. There is no user_id column here — the subject
-- is buried in the JSON, so a discovery pass that only joins on user_id
-- reports this table clean.
INSERT INTO analytics_events (event_name, properties, occurred_at) VALUES
    ('checkout_started',
     '{"cart_value": 4200, "actor": {"email": "ada@example.invalid", "plan": "free"}}',
     '2025-11-14T11:58:00Z'),
    ('page_view',
     '{"path": "/orders/9001", "actor": {"email": "ada@example.invalid"}}',
     '2025-11-15T07:20:00Z'),
    ('support_reply_sent',
     '{"ticket": 1, "recipient_name": "Ada Lentz"}',
     '2025-11-21T09:00:00Z'),
    ('page_view',
     '{"path": "/", "actor": {"email": "bram@example.invalid"}}',
     '2026-08-04T10:01:00Z');
