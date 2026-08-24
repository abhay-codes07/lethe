-- Capability separation, enforced by the database as well as the agent spec.
--
-- The scout connects as lethe_ro and the executor as lethe_rw. Discovery is
-- therefore incapable of writing at two independent layers: it holds no tool
-- that can, and the credential it holds would be refused if it did.
--
-- Defence in depth is the point. The agent-spec guarantee depends on the
-- harness resolving @read-only correctly against annotations supplied by an
-- MCP server. This guarantee depends on nothing but Postgres.

CREATE ROLE lethe_ro LOGIN PASSWORD 'lethe_demo_only';
CREATE ROLE lethe_rw LOGIN PASSWORD 'lethe_demo_only';

GRANT CONNECT ON DATABASE acme TO lethe_ro, lethe_rw;
GRANT USAGE ON SCHEMA public TO lethe_ro, lethe_rw;

-- Read-only: SELECT and nothing else, now and for tables added later.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO lethe_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO lethe_ro;

-- Explicitly revoked rather than merely ungranted, so a future GRANT ... TO
-- PUBLIC cannot quietly hand discovery the ability to write.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM lethe_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM lethe_ro;

-- Execution: writes, but only ever behind an approved plan and a human gate.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lethe_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lethe_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lethe_rw;

-- Neither role may drop anything. An erasure request is never a reason to
-- remove a table.
REVOKE ALL ON SCHEMA public FROM lethe_ro, lethe_rw;
GRANT USAGE ON SCHEMA public TO lethe_ro, lethe_rw;
