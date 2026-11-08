import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../supabase';
import { isAllowedOrigin } from '../env';
import { requirePortalPerm, holdsAll } from '../middleware/portalAuth';
import { requireIntegrationKey } from '../middleware/integrationAuth';
import { generateKey, INTEGRATION_PERMISSIONS, isIntegrationPermission, resourcesFor, RESOURCE_PERMISSIONS } from '../lib/integrationKeys';
import { fromStock } from '../lib/inventoryStock';

/**
 * Integration API: how other software reads a restaurant's data with an API key
 * (control-plane 0027). It implements the read side of the VAD REST connector
 * contract (Virtual AI Department's "Connect & discover"): base URL
 * <API>/api/integration, paths vad/v1/*, Bearer key, snake_case JSON, money as
 * decimals in the restaurant's currency, dates YYYY-MM-DD in its time zone.
 *
 *   GET vad/v1/capabilities                    any active key: system, the resources it may read, writes: []
 *   GET vad/v1/menu                            menu.view
 *   GET vad/v1/inventory                       stock.view + inventory.view_cost
 *   GET vad/v1/suppliers                       supplier.view
 *   GET vad/v1/invoices?from&to&supplier_id    invoices.view
 *   GET vad/v1/sales?from&to                   orders.view       served/paid orders per business day
 *   GET vad/v1/reports/food_cost?from&to       finance.view_cogs supplier invoice subtotals ÷ net sales
 *
 * Read-only: there are no write routes, and capabilities advertises none, so the other
 * system never offers to write. Server to server: no CORS.
 *
 * Key management, for the owner (Settings → Integrations), with the owner's own sign-in:
 *
 *   GET  /api/integration-keys?slug=          the restaurant's keys (never the key itself)
 *   POST /api/integration-keys                { slug, name, permissions } → the new key, shown once
 *   POST /api/integration-keys/:id/revoke     { slug }
 */
export const integrationRouter = express.Router();
export const integrationKeysRouter = express.Router();

// ── Reading, with a key ──────────────────────────────────────────────────────

const VERSION = '1.0.0';
const MAX_DAYS = 366;
const PAGE = 1000;
const dec = (cents: number) => Math.round(Number(cents ?? 0)) / 100;
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function failed(res: Response, what: string, err: { message?: string } | null) {
  console.error(`[integration] ${what} failed:`, err?.message);
  return res.status(502).json({ error: 'read_failed', message: `The ${what} could not be read. Please try again.` });
}

type Settings = { timezone: string; currency: string; dayStartMin: number };
async function settingsOf(admin: SupabaseClient): Promise<Settings> {
  const { data } = await admin.from('business_settings').select('timezone, currency_code, business_day_start_minutes').eq('id', true).maybeSingle();
  const s = (data ?? {}) as { timezone?: string; currency_code?: string; business_day_start_minutes?: number };
  return { timezone: s.timezone || 'UTC', currency: s.currency_code || 'USD', dayStartMin: Number(s.business_day_start_minutes ?? 0) };
}

/** The business day a moment belongs to, in the restaurant's time zone (the day can start after midnight). */
function businessDay(iso: string, s: Settings): string {
  const shifted = new Date(Date.parse(iso) - s.dayStartMin * 60_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: s.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
}

/** from/to as given (YYYY-MM-DD), defaulting to the last 30 days; at most a year. */
function dateRange(q: Record<string, unknown>, s: Settings): { from: string; to: string } | { error: string } {
  const today = businessDay(new Date().toISOString(), s);
  const to = isDate(q.to) ? q.to : today;
  const from = isDate(q.from) ? q.from : addDays(to, -29);
  if (from > to) return { error: 'from must not be after to' };
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 >= MAX_DAYS) return { error: `at most ${MAX_DAYS} days at a time` };
  return { from, to };
}

/** Every row of a query, a page at a time (PostgREST returns at most 1000 per request). */
async function allRows<T>(page: (lo: number, hi: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let lo = 0; lo < 50 * PAGE; lo += PAGE) {
    const { data, error } = await page(lo, lo + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

type SaleOrder = {
  created_at: string;
  subtotal_cents: number;
  refunded_cents: number;
  order_lines: { menu_item_id: string | null; deal_id: string | null; qty: number; line_total_cents: number }[];
};

/** Net sales (before tax, after refunds) of served and paid orders, per business day. */
async function salesByDay(admin: SupabaseClient, s: Settings, from: string, to: string) {
  // A wide UTC window, then the exact business day per order.
  const orders = await allRows<SaleOrder>((lo, hi) =>
    admin
      .from('orders')
      .select('created_at, subtotal_cents, refunded_cents, order_lines(menu_item_id, deal_id, qty, line_total_cents)')
      .in('status', ['served', 'paid'])
      .gte('created_at', `${addDays(from, -2)}T00:00:00Z`)
      .lt('created_at', `${addDays(to, 3)}T00:00:00Z`)
      .order('created_at')
      .range(lo, hi),
  );
  const days = new Map<string, { gross: number; orders: number; items: Map<string, { quantity: number; revenue: number }> }>();
  for (const o of orders) {
    const day = businessDay(o.created_at, s);
    if (day < from || day > to) continue;
    const d = days.get(day) ?? { gross: 0, orders: 0, items: new Map() };
    d.gross += Number(o.subtotal_cents) - Number(o.refunded_cents ?? 0);
    d.orders += 1;
    for (const l of o.order_lines ?? []) {
      const id = l.menu_item_id ?? (l.deal_id ? `deal:${l.deal_id}` : 'other');
      const it = d.items.get(id) ?? { quantity: 0, revenue: 0 };
      it.quantity += Number(l.qty);
      it.revenue += Number(l.line_total_cents);
      d.items.set(id, it);
    }
    days.set(day, d);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      gross: dec(d.gross),
      orders: d.orders,
      covers: 0, // guest counts aren't recorded
      items: [...d.items.entries()].map(([menu_item_id, it]) => ({ menu_item_id, quantity: it.quantity, revenue: dec(it.revenue) })),
    }));
}

integrationRouter.get('/vad/v1/capabilities', requireIntegrationKey(null), async (req: Request, res: Response) => {
  const { admin, tenantId, slug, permissions } = req.integration!;
  const [{ data: tenant }, s] = await Promise.all([
    supabaseAdmin.from('tenants').select('restaurant_name').eq('id', tenantId).maybeSingle(),
    settingsOf(admin),
  ]);
  return res.json({
    system: {
      name: 'Automation Restaurant',
      version: VERSION,
      restaurant: (tenant as { restaurant_name?: string } | null)?.restaurant_name ?? slug,
      currency: s.currency,
    },
    resources: resourcesFor(permissions),
    writes: [],
  });
});

integrationRouter.get('/vad/v1/menu', requireIntegrationKey('menu'), async (req: Request, res: Response) => {
  const { admin } = req.integration!;
  const [items, recipe] = await Promise.all([
    admin
      .from('menu_items')
      .select('id, name, description, price_cents, is_available, menu_categories(name), menu_variants(price_cents, is_available, sort_order)')
      .order('name'),
    admin.from('recipe_components').select('menu_item_id, inventory_items(id, sku)'),
  ]);
  if (items.error) return failed(res, 'menu', items.error);
  if (recipe.error) return failed(res, 'recipes', recipe.error);
  const skus = new Map<string, Set<string>>();
  for (const r of (recipe.data ?? []) as unknown as { menu_item_id: string; inventory_items: { id: string; sku: string | null } | null }[]) {
    if (!r.inventory_items) continue;
    const set = skus.get(r.menu_item_id) ?? new Set<string>();
    set.add(r.inventory_items.sku || r.inventory_items.id);
    skus.set(r.menu_item_id, set);
  }
  type Row = {
    id: string; name: string; description: string | null; price_cents: number; is_available: boolean;
    menu_categories: { name: string } | null;
    menu_variants: { price_cents: number; is_available: boolean; sort_order: number }[] | null;
  };
  const data = ((items.data ?? []) as unknown as Row[]).map((i) => {
    const variants = [...(i.menu_variants ?? [])].sort((a, b) => a.sort_order - b.sort_order);
    const onSale = variants.filter((v) => v.is_available);
    // A dish's price is its first variant's (the one the guest menu shows first).
    const price = (onSale[0] ?? variants[0])?.price_cents ?? i.price_cents;
    return {
      id: i.id,
      name: i.name,
      category: i.menu_categories?.name ?? 'Uncategorised',
      price: dec(price),
      description: i.description ?? '',
      allergens: [] as string[], // not recorded
      dietary: [] as string[], // not recorded
      ingredient_skus: [...(skus.get(i.id) ?? [])],
      available: i.is_available && (variants.length === 0 || onSale.length > 0),
    };
  });
  return res.json({ data });
});

integrationRouter.get('/vad/v1/inventory', requireIntegrationKey('inventory'), async (req: Request, res: Response) => {
  const { admin } = req.integration!;
  const [stock, preferred] = await Promise.all([
    fromStock((t) => admin.from(t).select('id, name, sku, unit, stock_qty, min_threshold, target_stock_qty, cost_cents_per_base_unit').order('name')),
    admin.from('supplier_items').select('inventory_item_id, supplier_id').eq('is_preferred', true).eq('is_active', true),
  ]);
  if (stock.error) return failed(res, 'inventory', stock.error);
  const pref = new Map(((preferred.data ?? []) as { inventory_item_id: string; supplier_id: string }[]).map((p) => [p.inventory_item_id, p.supplier_id]));
  type Row = { id: string; name: string; sku: string | null; unit: string; stock_qty: number | string; min_threshold: number | string; target_stock_qty: number | string | null; cost_cents_per_base_unit: number | string };
  const data = ((stock.data ?? []) as Row[]).map((i) => ({
    id: i.id,
    sku: i.sku || i.id,
    name: i.name,
    unit: i.unit,
    unit_cost: Math.round(Number(i.cost_cents_per_base_unit)) / 100,
    on_hand: Number(i.stock_qty),
    // The stock to reorder up to; the low-stock level when no target is set.
    par_level: Number(i.target_stock_qty ?? i.min_threshold),
    supplier_id: pref.get(i.id) ?? '',
  }));
  return res.json({ data });
});

integrationRouter.get('/vad/v1/suppliers', requireIntegrationKey('suppliers'), async (req: Request, res: Response) => {
  const { admin } = req.integration!;
  const { data, error } = await admin.from('suppliers').select('id, name, email, payment_terms').eq('is_active', true).order('name');
  if (error) return failed(res, 'suppliers', error);
  return res.json({ data: data ?? [] });
});

integrationRouter.get('/vad/v1/invoices', requireIntegrationKey('invoices'), async (req: Request, res: Response) => {
  const { admin } = req.integration!;
  const q = req.query as Record<string, unknown>;
  let query = admin
    .from('supplier_invoices')
    .select(
      'id, supplier_id, supplier_invoice_number, invoice_date, due_date, status, subtotal_cents, tax_cents, total_cents, ' +
        'supplier_invoice_lines(description, qty, unit_cost_cents, line_total_cents, inventory_items(sku, unit))',
    )
    .order('invoice_date')
    .limit(2000);
  if (isDate(q.from)) query = query.gte('invoice_date', q.from);
  if (isDate(q.to)) query = query.lte('invoice_date', q.to);
  if (typeof q.supplier_id === 'string' && q.supplier_id) query = query.eq('supplier_id', q.supplier_id);
  const { data, error } = await query;
  if (error) return failed(res, 'invoices', error);
  type Row = {
    id: string; supplier_id: string; supplier_invoice_number: string; invoice_date: string; due_date: string | null; status: string;
    subtotal_cents: number; tax_cents: number; total_cents: number;
    supplier_invoice_lines: { description: string; qty: number | string; unit_cost_cents: number; line_total_cents: number; inventory_items: { sku: string | null; unit: string } | null }[] | null;
  };
  return res.json({
    data: ((data ?? []) as unknown as Row[]).map((i) => ({
      id: i.id,
      supplier_id: i.supplier_id,
      invoice_number: i.supplier_invoice_number,
      invoice_date: i.invoice_date,
      due_date: i.due_date ?? i.invoice_date,
      status: i.status,
      lines: (i.supplier_invoice_lines ?? []).map((l) => ({
        sku: l.inventory_items?.sku ?? null,
        description: l.description,
        quantity: Number(l.qty),
        unit: l.inventory_items?.unit ?? 'unit',
        unit_cost: dec(l.unit_cost_cents),
        line_total: dec(l.line_total_cents),
      })),
      subtotal: dec(i.subtotal_cents),
      tax: dec(i.tax_cents),
      total: dec(i.total_cents),
    })),
  });
});

integrationRouter.get('/vad/v1/sales', requireIntegrationKey('sales'), async (req: Request, res: Response) => {
  const { admin } = req.integration!;
  const s = await settingsOf(admin);
  const r = dateRange(req.query as Record<string, unknown>, s);
  if ('error' in r) return res.status(422).json({ error: 'invalid_range', message: r.error });
  try {
    return res.json({ data: await salesByDay(admin, s, r.from, r.to) });
  } catch (err) {
    return failed(res, 'sales', err as Error);
  }
});

integrationRouter.get('/vad/v1/reports/food_cost', requireIntegrationKey('reports'), async (req: Request, res: Response) => {
  const { admin } = req.integration!;
  const s = await settingsOf(admin);
  const r = dateRange(req.query as Record<string, unknown>, s);
  if ('error' in r) return res.status(422).json({ error: 'invalid_range', message: r.error });
  try {
    const [days, invoices] = await Promise.all([
      salesByDay(admin, s, r.from, r.to),
      allRows<{ subtotal_cents: number }>((lo, hi) =>
        admin
          .from('supplier_invoices')
          .select('subtotal_cents')
          .gte('invoice_date', r.from)
          .lte('invoice_date', r.to)
          .neq('status', 'cancelled')
          .range(lo, hi),
      ),
    ]);
    const revenue = days.reduce((t, d) => t + Math.round(d.gross * 100), 0);
    const purchases = invoices.reduce((t, i) => t + Number(i.subtotal_cents), 0);
    return res.json({
      data: { from: r.from, to: r.to, purchases: dec(purchases), revenue: dec(revenue), food_cost_pct: revenue ? Math.round((purchases / revenue) * 10_000) / 100 : null },
    });
  } catch (err) {
    return failed(res, 'food cost report', err as Error);
  }
});

// ── Managing keys, as the owner ──────────────────────────────────────────────

integrationKeysRouter.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
});

/** Keys read without anyone signed in, so only the restaurant's owner manages them. */
function ownerOnly(req: Request, res: Response): boolean {
  const { role, permissions } = req.tenant!;
  if (role === 'owner' || permissions.includes('*')) return true;
  res.status(403).json({ error: 'owner_only', message: 'Only the restaurant owner can manage integration keys.' });
  return false;
}

async function tenantIdFor(slug: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('tenants').select('id').eq('slug', slug).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

const KEY_COLUMNS = 'id, name, key_prefix, permissions, created_at, created_by_email, last_used_at, revoked_at';

integrationKeysRouter.get('/', requirePortalPerm('settings.update'), async (req: Request, res: Response) => {
  if (!ownerOnly(req, res)) return;
  const tenantId = await tenantIdFor(req.tenant!.slug);
  if (!tenantId) return res.status(404).json({ error: 'restaurant_not_found' });
  const { data, error } = await supabaseAdmin.from('integration_keys').select(KEY_COLUMNS).eq('tenant_id', tenantId).order('created_at', { ascending: false });
  if (error) {
    console.error('[integration] list failed:', error.message);
    return res.status(502).json({ error: 'list_failed', message: 'The keys could not be loaded. Please try again.' });
  }
  return res.json({ keys: data ?? [], permissions: INTEGRATION_PERMISSIONS, resources: RESOURCE_PERMISSIONS });
});

const createSchema = z.object({
  slug: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  permissions: z.array(z.string()).min(1).refine((p) => p.every(isIntegrationPermission), { message: 'only read permissions' }),
});

integrationKeysRouter.post('/', express.json(), requirePortalPerm('settings.update'), async (req: Request, res: Response) => {
  if (!ownerOnly(req, res)) return;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request', message: 'Give the key a name and at least one read permission.' });
  const { admin, slug, userId, email, role, permissions: callerPerms } = req.tenant!;
  const permissions = [...new Set(parsed.data.permissions)];
  // Same rule as portals: nobody hands out access they don't hold themselves.
  if (!holdsAll(callerPerms, role, permissions)) {
    return res.status(403).json({ error: 'forbidden', message: "A key can't have a permission you don't have." });
  }
  const tenantId = await tenantIdFor(slug);
  if (!tenantId) return res.status(404).json({ error: 'restaurant_not_found' });
  const { key, prefix, hash } = generateKey();
  const { data, error } = await supabaseAdmin
    .from('integration_keys')
    .insert({ tenant_id: tenantId, name: parsed.data.name, key_prefix: prefix, key_hash: hash, permissions, created_by: userId, created_by_email: email })
    .select(KEY_COLUMNS)
    .single();
  if (error || !data) {
    console.error('[integration] create failed:', error?.message);
    return res.status(502).json({ error: 'create_failed', message: 'The key could not be created. Please try again.' });
  }
  await admin.from('audit_logs').insert({
    actor_id: userId,
    actor_email: email,
    actor_role: role,
    action: 'integration_key.created',
    entity: 'integration_keys',
    entity_id: data.id,
    after: { name: data.name, key_prefix: prefix, permissions },
  });
  // The only time the key is ever returned.
  return res.status(201).json({ key, record: data });
});

integrationKeysRouter.post('/:id/revoke', express.json(), requirePortalPerm('settings.update'), async (req: Request, res: Response) => {
  if (!ownerOnly(req, res)) return;
  const { admin, slug, userId, email, role } = req.tenant!;
  const tenantId = await tenantIdFor(slug);
  if (!tenantId) return res.status(404).json({ error: 'restaurant_not_found' });
  // Scoped to this restaurant: a key id from another restaurant matches nothing.
  const { data, error } = await supabaseAdmin
    .from('integration_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .is('revoked_at', null)
    .select('id, name, key_prefix')
    .maybeSingle();
  if (error) {
    console.error('[integration] revoke failed:', error.message);
    return res.status(502).json({ error: 'revoke_failed', message: 'The key could not be revoked. Please try again.' });
  }
  if (!data) return res.status(404).json({ error: 'not_found', message: 'That key was not found, or it is already revoked.' });
  await admin.from('audit_logs').insert({
    actor_id: userId,
    actor_email: email,
    actor_role: role,
    action: 'integration_key.revoked',
    entity: 'integration_keys',
    entity_id: data.id,
    before: { name: data.name, key_prefix: data.key_prefix },
  });
  return res.json({ ok: true });
});
