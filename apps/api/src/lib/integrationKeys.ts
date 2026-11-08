import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '../supabase';

/**
 * Integration API keys (control-plane 0027). A key is
 *
 *   ar_live_<id>_<secret>      id: 10 base62 chars, secret: 32 random bytes (base64url)
 *
 * Only `ar_live_<id>` (to find the row) and a sha-256 of the whole key are stored;
 * the key is returned once, when it is created.
 *
 * A key holds the restaurant's own permission keys (tenant permission_catalog) —
 * read-only ones only, for now — and each resource of the VAD connector contract
 * needs the same permissions a staff login would need to see that data.
 */
export const INTEGRATION_PERMISSIONS = [
  'menu.view', 'stock.view', 'inventory.view_cost', 'supplier.view', 'invoices.view', 'orders.view', 'finance.view_cogs',
] as const;
export type IntegrationPermission = (typeof INTEGRATION_PERMISSIONS)[number];

export function isIntegrationPermission(s: unknown): s is IntegrationPermission {
  return typeof s === 'string' && (INTEGRATION_PERMISSIONS as readonly string[]).includes(s);
}

/** VAD connector resources (GET /vad/v1/<resource>) and the permissions each one needs. */
export const RESOURCE_PERMISSIONS = {
  menu: ['menu.view'],
  inventory: ['stock.view', 'inventory.view_cost'],
  suppliers: ['supplier.view'],
  invoices: ['invoices.view'],
  sales: ['orders.view'],
  reports: ['finance.view_cogs'],
} as const satisfies Record<string, readonly IntegrationPermission[]>;
export type IntegrationResource = keyof typeof RESOURCE_PERMISSIONS;

/** The resources a key's permissions unlock — what /vad/v1/capabilities advertises. */
export function resourcesFor(permissions: string[]): IntegrationResource[] {
  return (Object.keys(RESOURCE_PERMISSIONS) as IntegrationResource[]).filter((r) =>
    RESOURCE_PERMISSIONS[r].every((p) => permissions.includes(p)),
  );
}

const PREFIX = 'ar_live_';
const KEY_RE = /^ar_live_([0-9A-Za-z]{10})_([0-9A-Za-z_-]{43})$/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function base62(n: number): string {
  // Rejection sampling keeps every character equally likely.
  let out = '';
  while (out.length < n) {
    for (const b of randomBytes(n * 2)) {
      if (b < 248 && out.length < n) out += BASE62[b % 62];
    }
  }
  return out;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateKey(): { key: string; prefix: string; hash: string } {
  const prefix = `${PREFIX}${base62(10)}`;
  const key = `${prefix}_${randomBytes(32).toString('base64url')}`;
  return { key, prefix, hash: hashKey(key) };
}

export type IntegrationKeyRow = {
  id: string;
  tenant_id: string;
  name: string;
  key_prefix: string;
  permissions: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** The active key a presented string belongs to, or null (malformed, unknown, revoked or wrong secret). */
export async function findActiveKey(presented: string): Promise<(IntegrationKeyRow & { tenant_slug: string }) | null> {
  const m = KEY_RE.exec(presented.trim());
  if (!m) return null;
  const prefix = `${PREFIX}${m[1]}`;
  const { data, error } = await supabaseAdmin
    .from('integration_keys')
    .select('id, tenant_id, name, key_prefix, key_hash, permissions, created_at, last_used_at, revoked_at, tenants!inner(slug, status)')
    .eq('key_prefix', prefix)
    .maybeSingle();
  if (error) throw new Error(`integration key lookup failed: ${error.message}`);
  if (!data || data.revoked_at) return null;
  const want = Buffer.from(String(data.key_hash), 'hex');
  const got = Buffer.from(hashKey(presented.trim()), 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const tenant = (Array.isArray(data.tenants) ? data.tenants[0] : data.tenants) as { slug: string; status: string | null } | undefined;
  // An archived branch or a cancelled restaurant answers no one.
  if (!tenant?.slug || tenant.status !== 'active') return null;
  const { key_hash: _hash, tenants: _t, ...row } = data as typeof data & { key_hash: string; tenants: unknown };
  return { ...(row as IntegrationKeyRow), tenant_slug: tenant.slug };
}

// last_used_at is written at most once every 5 minutes per key.
const lastTouched = new Map<string, number>();
export function touchKey(id: string): void {
  const now = Date.now();
  if (now - (lastTouched.get(id) ?? 0) < 5 * 60_000) return;
  lastTouched.set(id, now);
  void supabaseAdmin
    .from('integration_keys')
    .update({ last_used_at: new Date(now).toISOString() })
    .eq('id', id)
    .then(({ error }) => {
      if (error) console.error('[integration] last_used_at update failed:', error.message);
    });
}
