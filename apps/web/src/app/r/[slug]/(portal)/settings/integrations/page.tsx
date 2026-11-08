import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage } from '@/lib/permissions';
import { baseSlug } from '@/lib/sessionSlot';
import { IntegrationKeysManager } from './IntegrationKeysManager';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Integrations' };

export default async function IntegrationsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  // Keys are created, listed and revoked by the API, which also checks this is the owner.
  await gatePortalPage(t.client, slug, 'settings.view', { ownerOnly: true });

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-black">Integrations</h1>
        <p className="text-muted text-xs mt-1">
          API keys let other software (a POS, accounting or delivery tool) read this restaurant&apos;s menu, orders and stock.
          Keys are read-only, shown once, and can be revoked at any time.
        </p>
      </div>
      <IntegrationKeysManager slug={baseSlug(slug)} />
    </div>
  );
}
