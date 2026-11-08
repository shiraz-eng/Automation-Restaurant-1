-- ============================================================================
-- 0027 — Integration API keys: how other software reads a restaurant's data.
--
-- The owner creates a key in Settings → Integrations and gives it, with the
-- base URL, to the other system (e.g. Virtual AI Department's "Connect &
-- discover"). That system calls /api/integration/vad/v1/* with
--   Authorization: Bearer ar_live_<id>_<secret>
--
--   key_prefix   'ar_live_<id>': the public part, shown in lists and used to
--                find the row. Unique.
--   key_hash     sha-256 (hex) of the whole key. The key itself is shown once
--                at creation and never stored, so it can't be shown again.
--   permissions  the restaurant's own permission keys (tenant permission_catalog),
--                read-only ones only: a key reads exactly what a staff login with
--                those permissions could read.
--
-- A key belongs to one restaurant (a branch is a restaurant of its own, so it
-- gets its own keys). Revoking sets revoked_at; the row is kept for the record.
-- Service role only: no policies, so anon and authenticated get nothing.
-- ============================================================================

create table if not exists public.integration_keys (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 80),
  key_prefix       text not null unique,
  key_hash         text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  permissions      text[] not null default '{}'
                   check (permissions <@ array['menu.view', 'stock.view', 'inventory.view_cost', 'supplier.view',
                                               'invoices.view', 'orders.view', 'finance.view_cogs']::text[]),
  created_by       uuid,
  created_by_email text,
  created_at       timestamptz not null default now(),
  last_used_at     timestamptz,
  revoked_at       timestamptz
);

create index if not exists integration_keys_tenant_idx on public.integration_keys (tenant_id, created_at desc);

comment on table public.integration_keys is
  'Per-restaurant API keys for other software (read-only permissions). Only a sha-256 hash of each key is stored.';

alter table public.integration_keys enable row level security;
-- No policies → only the service role (the API) can read or write.
