import type { Request, Response, NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTenantClient } from '../lib/tenantAdmin';
import { findActiveKey, touchKey, RESOURCE_PERMISSIONS, type IntegrationResource } from '../lib/integrationKeys';

/** What requireIntegrationKey() attaches: the restaurant the key belongs to, and the key. */
export type IntegrationContext = {
  keyId: string;
  keyName: string;
  permissions: string[];
  tenantId: string;
  slug: string;
  admin: SupabaseClient;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      integration?: IntegrationContext;
    }
  }
}

// 120 requests a minute per key, per warm instance.
const WINDOW_MS = 60_000;
const LIMIT = 120;
const hits = new Map<string, { n: number; start: number }>();
function overLimit(keyId: string): boolean {
  const now = Date.now();
  const h = hits.get(keyId);
  if (!h || now - h.start > WINDOW_MS) {
    hits.set(keyId, { n: 1, start: now });
    return false;
  }
  return ++h.n > LIMIT;
}

/**
 * Express middleware for the integration API: the key comes from
 * `Authorization: Bearer <key>` or `X-Api-Key: <key>`. The restaurant is the
 * key's own — never anything the request names — and the key must hold every
 * permission `resource` needs (null = any active key, e.g. capabilities).
 */
export function requireIntegrationKey(resource: IntegrationResource | null) {
  return async function integrationGuard(req: Request, res: Response, next: NextFunction) {
    const auth = req.headers.authorization;
    const presented = auth?.startsWith('Bearer ') ? auth.slice(7) : String(req.headers['x-api-key'] ?? '');
    if (!presented) {
      return res.status(401).json({ error: 'api_key_required', message: 'Send the integration key as "Authorization: Bearer <key>".' });
    }
    let key;
    try {
      key = await findActiveKey(presented);
    } catch (err) {
      console.error('[integration] key check failed:', err);
      return res.status(503).json({ error: 'service_unavailable', message: 'Please try again in a moment.' });
    }
    if (!key) return res.status(401).json({ error: 'invalid_api_key', message: 'This key is not valid, or it has been revoked.' });
    if (overLimit(key.id)) {
      res.header('Retry-After', '60');
      return res.status(429).json({ error: 'rate_limited', message: `At most ${LIMIT} requests a minute per key.` });
    }
    const missing = resource ? RESOURCE_PERMISSIONS[resource].filter((p) => !key.permissions.includes(p)) : [];
    if (missing.length) {
      return res.status(403).json({ error: 'insufficient_permission', message: `This key can't read ${resource}.`, missing });
    }
    const resolved = await resolveTenantClient(key.tenant_slug);
    if (!resolved.ok) {
      return res.status(503).json({ error: 'service_unavailable', message: "The restaurant's data can't be reached right now. Please try again." });
    }
    touchKey(key.id);
    req.integration = {
      keyId: key.id,
      keyName: key.name,
      permissions: key.permissions,
      tenantId: key.tenant_id,
      slug: key.tenant_slug,
      admin: resolved.client.admin,
    };
    next();
  };
}
