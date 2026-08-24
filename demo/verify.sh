#!/usr/bin/env bash
#
# Check the demo estate is up and contains what the tests assume.
#
# This exists because the estate is the one part of the project that cannot be
# verified in CI — it needs Docker. Running it is the substitute, and it
# asserts the specific cases that make the demo worth watching rather than
# merely that the containers started.
#
#   docker compose -f demo/docker-compose.yml up -d
#   ./demo/verify.sh

set -euo pipefail

PGHOST=${PGHOST:-localhost}
PGPORT=${PGPORT:-55432}
MINIO_PORT=${MINIO_PORT:-59000}
QDRANT_PORT=${QDRANT_PORT:-56333}

fail=0

check() {
  local label=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then
    printf '  ok    %s\n' "$label"
  else
    printf '  FAIL  %s (expected %s, got %s)\n' "$label" "$expected" "$actual"
    fail=1
  fi
}

psql_ro() {
  PGPASSWORD=lethe_demo_only psql -h "$PGHOST" -p "$PGPORT" -U lethe_ro -d acme -tAc "$1" 2>/dev/null
}

echo "services"
pg_isready -h "$PGHOST" -p "$PGPORT" -q && printf '  ok    postgres accepting connections\n' \
  || { printf '  FAIL  postgres not ready\n'; fail=1; }
curl -fsS "http://localhost:${MINIO_PORT}/minio/health/live" >/dev/null 2>&1 \
  && printf '  ok    minio live\n' || { printf '  FAIL  minio not ready\n'; fail=1; }
curl -fsS "http://localhost:${QDRANT_PORT}/readyz" >/dev/null 2>&1 \
  && printf '  ok    qdrant ready\n' || { printf '  FAIL  qdrant not ready\n'; fail=1; }

echo
echo "the subject exists, and so does the control"
check "Ada present"  "1" "$(psql_ro "SELECT count(*) FROM users WHERE id = 4471")"
check "Bram present" "1" "$(psql_ro "SELECT count(*) FROM users WHERE id = 4472")"

echo
echo "the cases that make erasure hard"
check "sessions to delete outright"        "3" "$(psql_ro "SELECT count(*) FROM sessions WHERE user_id = 4471")"
check "invoice retained under tax rule"    "1" "$(psql_ro "SELECT count(*) FROM invoices WHERE customer_id = 4471")"
check "open legal hold, retained intact"   "1" "$(psql_ro "SELECT count(*) FROM legal_holds WHERE subject_id = 4471 AND closed_at IS NULL")"
check "special category, escalated"        "1" "$(psql_ro "SELECT count(*) FROM accessibility_preferences WHERE user_id = 4471")"
check "tickets feeding the vector index"   "2" "$(psql_ro "SELECT count(*) FROM support_tickets WHERE user_id = 4471")"

echo
echo "the referential trap"
check "order that cannot be hard-deleted"  "1" "$(psql_ro "SELECT count(*) FROM orders WHERE customer_id = 4471")"
check "order_items that would be orphaned" "2" "$(psql_ro "SELECT count(*) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.customer_id = 4471")"

echo
echo "the rows a checklist misses"
# No user_id column here — a discovery pass that only joins on user_id reports
# this table clean. This is the finding that makes the demo worth watching.
check "analytics rows reachable only via JSON" "3" \
  "$(psql_ro "SELECT count(*) FROM analytics_events WHERE properties::text LIKE '%ada@example.invalid%' OR properties::text LIKE '%Ada Lentz%'")"

echo
echo "discovery credentials cannot write"
# Wrapped in a rolled-back transaction. If the role is misconfigured the write
# would otherwise succeed and destroy the estate mid-check — a verification
# step that damages what it is verifying is worse than no check.
if psql_ro "BEGIN; DELETE FROM sessions WHERE user_id = 4471; ROLLBACK;" >/dev/null 2>&1; then
  printf '  FAIL  lethe_ro was able to DELETE — the read-only role is not read-only\n'
  fail=1
else
  printf '  ok    lethe_ro refused DELETE\n'
fi
if psql_ro "BEGIN; UPDATE users SET full_name = 'x' WHERE id = 4471; ROLLBACK;" >/dev/null 2>&1; then
  printf '  FAIL  lethe_ro was able to UPDATE\n'
  fail=1
else
  printf '  ok    lethe_ro refused UPDATE\n'
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "estate verified"
else
  echo "estate NOT verified — see failures above"
  exit 1
fi
