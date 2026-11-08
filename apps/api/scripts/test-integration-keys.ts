// Integration API keys (control-plane 0027): offline checks of the key format and the
// middleware's refusals, plus — with --live <key> against a running API — the VAD connector
// contract endpoints.
// Usage (from apps/api):
//   npx tsx scripts/test-integration-keys.ts
//   npx tsx scripts/test-integration-keys.ts --live <ar_live_…> [https://automation-restaurant-api.vercel.app]
import express from 'express';
import type { AddressInfo } from 'node:net';
import { generateKey, hashKey, isIntegrationPermission, INTEGRATION_PERMISSIONS, resourcesFor } from '../src/lib/integrationKeys';
import { requireIntegrationKey } from '../src/middleware/integrationAuth';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

async function offline() {
  const keys = Array.from({ length: 200 }, () => generateKey());
  const re = /^ar_live_[0-9A-Za-z]{10}_[0-9A-Za-z_-]{43}$/;
  check('every key has the documented format', keys.every((k) => re.test(k.key)));
  check('prefix is the key up to the secret', keys.every((k) => k.key.startsWith(`${k.prefix}_`)));
  check('hash is sha-256 hex of the whole key', keys.every((k) => /^[0-9a-f]{64}$/.test(k.hash) && k.hash === hashKey(k.key)));
  check('200 keys, 200 different prefixes', new Set(keys.map((k) => k.prefix)).size === 200);
  check('only read permissions can be granted', INTEGRATION_PERMISSIONS.every((p) => /\.view/.test(p)) && !isIntegrationPermission('menu.update') && !isIntegrationPermission('*'));
  check('inventory needs stock and cost', JSON.stringify(resourcesFor(['stock.view'])) === '[]' && resourcesFor(['stock.view', 'inventory.view_cost']).includes('inventory'));

  // The middleware refuses before touching the database when there is no key or it is malformed.
  const app = express();
  app.get('/t', requireIntegrationKey('menu'), (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/t`;
  const none = await fetch(base);
  check('no key → 401 api_key_required', none.status === 401 && (await none.json()).error === 'api_key_required');
  const bad = await fetch(base, { headers: { Authorization: 'Bearer not-a-key' } });
  check('malformed key → 401 invalid_api_key', bad.status === 401 && (await bad.json()).error === 'invalid_api_key');
  const viaHeader = await fetch(base, { headers: { 'X-Api-Key': 'ar_live_short' } });
  check('X-Api-Key header is read too', viaHeader.status === 401 && (await viaHeader.json()).error === 'invalid_api_key');
  server.close();
}

async function live(key: string, api: string) {
  const get = (p: string, k = key) => fetch(`${api}/api/integration/vad/v1/${p}`, { headers: { Authorization: `Bearer ${k}` } });
  const cap = await get('capabilities');
  const capJ = await cap.json();
  check('capabilities answers (Connect & discover)', cap.ok && capJ.system?.name === 'Automation Restaurant' && Array.isArray(capJ.writes) && capJ.writes.length === 0, JSON.stringify(capJ));
  const allowed: string[] = capJ.resources ?? [];
  for (const [res, path] of [['menu', 'menu'], ['inventory', 'inventory'], ['suppliers', 'suppliers'], ['invoices', 'invoices'], ['sales', 'sales'], ['reports', 'reports/food_cost']] as const) {
    const r = await get(path);
    const j = await r.json();
    const ok = allowed.includes(res) ? r.ok && 'data' in j : r.status === 403;
    check(`${path} → ${allowed.includes(res) ? '200' : '403 (not granted)'}`, ok, r.ok ? `${Array.isArray(j.data) ? j.data.length + ' rows' : 'object'}` : j.error);
  }
  const tampered = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
  check('right prefix, wrong secret → 401', (await get('capabilities', tampered)).status === 401);
  const write = await fetch(`${api}/api/integration/vad/v1/invoices`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } });
  check('no write endpoints (POST → 404)', write.status === 404);
}

(async () => {
  await offline();
  const i = process.argv.indexOf('--live');
  if (i > 0) await live(process.argv[i + 1]!, process.argv[i + 2] ?? 'http://localhost:4000');
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
  process.exitCode = failed ? 1 : 0;
})();
