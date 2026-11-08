'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type KeyRecord = {
  id: string;
  name: string;
  key_prefix: string;
  permissions: string[];
  created_at: string;
  created_by_email: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
};

// The restaurant's own permission keys, read-only ones only (control-plane 0027 refuses others).
const SCOPES: { key: string; label: string; hint: string }[] = [
  { key: 'menu.view', label: 'Menu', hint: 'Dishes, categories, prices, recipe ingredients, on sale or not.' },
  { key: 'stock.view', label: 'Stock', hint: 'Ingredients, stock on hand, par levels (inventory also needs costs).' },
  { key: 'inventory.view_cost', label: 'Ingredient costs', hint: 'Unit cost of each ingredient.' },
  { key: 'supplier.view', label: 'Suppliers', hint: 'Supplier names, e-mail and payment terms.' },
  { key: 'invoices.view', label: 'Supplier invoices', hint: 'Invoices and their lines.' },
  { key: 'orders.view', label: 'Sales', hint: 'Net sales per day and per dish. No guest names.' },
  { key: 'finance.view_cogs', label: 'Food cost report', hint: 'Purchases vs revenue for a period.' },
];

/**
 * Creates, lists and revokes integration API keys through /api/integration-keys
 * (owner only, audited). A new key is shown once, here, and never again.
 */
export function IntegrationKeysManager({ slug }: { slug: string }) {
  const supabase = usePortalSupabase();
  const token = useCallback(async () => (await supabase.auth.getSession()).data.session?.access_token ?? '', [supabase]);
  const [keys, setKeys] = useState<KeyRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<string>>(new Set(SCOPES.map((s) => s.key)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`${API}/api/integration-keys?slug=${encodeURIComponent(slug)}`, {
        headers: { Authorization: `Bearer ${await token()}` },
      });
      const j = (await res.json().catch(() => ({}))) as { keys?: KeyRecord[]; message?: string };
      if (!res.ok) throw new Error(j.message ?? 'The keys could not be loaded.');
      setKeys(j.keys ?? []);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [slug, token]);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/integration-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ slug, name: name.trim(), permissions: [...scopes] }),
      });
      const j = (await res.json().catch(() => ({}))) as { key?: string; record?: KeyRecord; message?: string };
      if (!res.ok || !j.key || !j.record) throw new Error(j.message ?? 'The key could not be created.');
      setCreated({ key: j.key, name: j.record.name });
      setName('');
      setKeys((k) => [j.record!, ...(k ?? [])]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k: KeyRecord) {
    if (!window.confirm(`Revoke "${k.name}"? Software using it stops working straight away. This can't be undone.`)) return;
    setError(null);
    const res = await fetch(`${API}/api/integration-keys/${k.id}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ slug }),
    });
    const j = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) return setError(j.message ?? 'The key could not be revoked.');
    await load();
  }

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  }

  const baseUrl = `${API}/api/integration`;

  return (
    <div className="space-y-5">
      <Card className="space-y-3">
        <h2 className="text-sm font-bold">Connection details</h2>
        <div className="grid gap-2 text-xs sm:grid-cols-[8rem_1fr_auto] sm:items-center">
          <span className="text-muted font-semibold">Base URL</span>
          <code className="break-all rounded border border-border bg-main px-2 py-1.5">{baseUrl}</code>
          <Button type="button" variant="ghost" onClick={() => copy('url', baseUrl)}>
            {copied === 'url' ? 'Copied' : 'Copy'}
          </Button>
          <span className="text-muted font-semibold">Authentication</span>
          <code className="break-all rounded border border-border bg-main px-2 py-1.5 sm:col-span-2">Authorization: Bearer &lt;your key&gt;</code>
        </div>
        <p className="text-[0.6875rem] text-muted">
          VAD connector contract: <code>vad/v1/capabilities</code>, <code>menu</code>, <code>inventory</code>, <code>suppliers</code>, <code>invoices</code>, <code>sales</code>, <code>reports/food_cost</code>. Server to server only:
          never put a key in a web page or app that others can open.
        </p>
      </Card>

      {created && (
        <Card className="space-y-3 border-ok/50">
          <h2 className="text-sm font-bold">Your new key: “{created.name}”</h2>
          <p className="text-xs">
            Copy it now and paste it into the other software. <strong>It won&apos;t be shown again</strong>; if it&apos;s lost, revoke it
            and create a new one.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="flex-1 break-all rounded border border-border bg-main px-2 py-1.5 text-xs" translate="no">
              {created.key}
            </code>
            <Button type="button" onClick={() => copy('key', created.key)}>
              {copied === 'key' ? 'Copied' : 'Copy key'}
            </Button>
          </div>
          <Button type="button" variant="ghost" onClick={() => setCreated(null)}>
            I&apos;ve saved it
          </Button>
        </Card>
      )}

      <Card>
        <form onSubmit={create} className="space-y-4">
          <h2 className="text-sm font-bold">Create a key</h2>
          <Field label="Name" hint="Who will use it, e.g. “Accounting sync” or “Delivery tablet”.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required placeholder="Accounting sync" />
          </Field>
          <fieldset>
            <legend className="text-muted text-[0.6875rem] font-semibold">What it may read</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {SCOPES.map((s) => (
                <label key={s.key} className="flex items-start gap-2 rounded border border-border p-2.5 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={scopes.has(s.key)}
                    onChange={(e) =>
                      setScopes((cur) => {
                        const next = new Set(cur);
                        if (e.target.checked) next.add(s.key);
                        else next.delete(s.key);
                        return next;
                      })
                    }
                  />
                  <span>
                    <span className="font-semibold">{s.label}</span> <span className="text-muted">· read only</span>
                    <span className="block text-[0.6875rem] text-muted">{s.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {error && (
            <p role="alert" className="text-xs font-semibold text-danger">
              ⚠ {error}
            </p>
          )}
          <Button type="submit" disabled={busy || !name.trim() || scopes.size === 0}>
            {busy ? 'Creating…' : 'Create key'}
          </Button>
        </form>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-bold">Keys</h2>
        {loadError ? (
          <p role="alert" className="text-xs text-danger">
            ⚠ {loadError}
          </p>
        ) : keys === null ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="text-xs text-muted">No keys yet.</p>
        ) : (
          <div className="overflow-x-auto" tabIndex={0} role="group" aria-label="Integration keys — scroll to see more">
            <table className="w-full text-start text-xs">
              <thead className="text-muted">
                <tr className="border-b border-border">
                  <th className="py-2 text-start font-semibold">Name</th>
                  <th className="py-2 text-start font-semibold">Key</th>
                  <th className="py-2 text-start font-semibold">Reads</th>
                  <th className="py-2 text-start font-semibold">Last used</th>
                  <th className="py-2 text-start font-semibold">Status</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className="border-b border-border/60 last:border-0 align-top">
                    <td className="py-2 pe-3">
                      <span className="font-semibold">{k.name}</span>
                      <span className="block text-[0.6875rem] text-muted">Created {formatDateTime(k.created_at)}</span>
                    </td>
                    <td className="py-2 pe-3 font-mono">{k.key_prefix}_…</td>
                    <td className="py-2 pe-3">{k.permissions.join(', ')}</td>
                    <td className="py-2 pe-3">{k.last_used_at ? formatDateTime(k.last_used_at) : 'Never'}</td>
                    <td className="py-2 pe-3">
                      {k.revoked_at ? <span className="text-danger">Revoked</span> : <span className="text-ok">Active</span>}
                    </td>
                    <td className="py-2 text-end">
                      {!k.revoked_at && (
                        <Button type="button" variant="danger" onClick={() => revoke(k)}>
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
