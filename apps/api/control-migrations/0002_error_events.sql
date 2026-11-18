-- Up Migration
-- SERVER ERRORS, for the platform admin. One row per failed request (HTTP 5xx), so the operator can see
-- which restaurant is having trouble before the owner phones. It holds NO request or business data:
-- only the status, the stable error code, the method, the route shape (ids replaced by :id, no query
-- string) and the request id that also appears in the server log. Old rows are purged (30 days).

CREATE TABLE error_events (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  tenant_id  uuid REFERENCES tenants(id),           -- NULL: the platform itself, or an unknown code
  status     int NOT NULL CHECK (status BETWEEN 500 AND 599),
  code       text,
  method     text NOT NULL,
  route      text NOT NULL,
  request_id text
);
CREATE INDEX error_events_tenant_idx ON error_events(tenant_id, at DESC);
CREATE INDEX error_events_at_idx ON error_events(at DESC);
