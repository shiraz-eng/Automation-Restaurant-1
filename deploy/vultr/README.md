# Automation Restaurant on Vultr

**Vultr Agent Rush hackathon · Challenge 2: Powering the Future of Work**

Automation Restaurant is an AI-powered operations platform for restaurants. Ordering,
the kitchen, recipe-based stock, purchasing, supplier invoices, finance and an AI
assistant all read and write one live data layer. This page explains how it runs on Vultr.

| | |
| --- | --- |
| **Live demo** | https://96-30-205-151.sslip.io |
| **API on Vultr** | https://api.96-30-205-151.sslip.io/health |
| **Vultr service** | Cloud Compute VM (Shared CPU, 2 vCPU / 4 GB, Ubuntu, Atlanta) |
| **Repository** | https://github.com/shiraz-eng/Automation-Restaurant-1 |

## How Vultr powers the platform

The Vultr VM is the central backend, not static hosting. Everything that serves users and
everything that runs on a schedule runs there:

```
                       Vultr Cloud Compute VM (Ubuntu, Docker Compose)
  owners, staff,  ──HTTPS──►  Caddy (automatic Let's Encrypt certificates)
  kitchen tablets,             │
  guests' phones               ├── <ip>.sslip.io      ──►  web   Next.js 15 · React 19 (standalone server)
                               └── api.<ip>.sslip.io  ──►  api   Express · TypeScript (long-running)
                                                              │
                                                              ├── background workflows (every 5–15 min)
                                                              │     · provisioning retries for new restaurants
                                                              │     · low-stock supplier reorder e-mails
                                                              │     · recipe cost-change detection
                                                              │     · attendance auto-absent
                                                              ├── AI assistant: Gemini, called only from here,
                                                              │   over 71 permission-checked tools
                                                              ├── integration API (read-only keys) for other systems
                                                              └── each restaurant's own Supabase Postgres (RLS)
```

- **Web app:** the restaurant portal, the kitchen display, the guest QR menu and the
  marketing site.
- **API:** every action that needs a secret: provisioning restaurants, billing, e-mail, AI
  calls, document imports and the integration API. It works out the restaurant and the
  person's permissions from their sign-in token, never from what the browser sends.
- **Background workflows:** these need a process that keeps running. Serverless hosting
  stops between requests; the Vultr VM runs them continuously.
- **Secrets** (database service keys, AI key, e-mail) live only in env files on the VM. They
  are never in Git, never in the Docker images and never sent to the browser.

## The future-of-work workflows it runs

| Area | What happens, automatically |
| --- | --- |
| **Procurement** | Low stock → purchase order → goods received → stock updated → supplier invoice matched against the order and the delivery before it can be paid |
| **Finance & accounting** | Every sale, food cost, expense and supplier bill is written to an append-only ledger; P&L, payables, cash and a locked day close; PDF and Excel reports |
| **Operations** | Each order deducts its recipe's exact ingredients; priority allocation shares scarce stock between dishes; waste needs a manager's approval |
| **AI assistant** | Answers from live data (for example "which items are running low?") and only *proposes* actions; a person confirms. It never approves expenses or pays anyone |

## Deploy it on your own Vultr VM

1. In the Vultr console, **Create Instance**: Shared CPU, **2 vCPU / 4 GB**, **Ubuntu 24.04 LTS**
   (newer versions work too), with your SSH key.
2. On the server, as root:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/shiraz-eng/Automation-Restaurant-1/main/deploy/vultr/deploy.sh | bash
   ```

   It installs Docker, adds swap for the build, downloads the code, then asks for your
   two env files.
3. From your computer, copy them up (PowerShell shown):

   ```powershell
   scp apps\api\.env root@<server-ip>:/opt/automation-restaurant/deploy/vultr/api.env
   scp apps\web\.env.local root@<server-ip>:/opt/automation-restaurant/deploy/vultr/web.env
   ```

4. Run it again: `bash /opt/automation-restaurant/deploy/vultr/deploy.sh [your-domain]`.
   The first build takes about 5–10 minutes. Without a domain it serves
   `https://<server-ip-with-dashes>.sslip.io` and `https://api.<…>.sslip.io`.

| File | Purpose |
| --- | --- |
| [`deploy.sh`](deploy.sh) | One-command install, update and start |
| [`docker-compose.yml`](docker-compose.yml) | The three services: `web`, `api`, `caddy` |
| [`Dockerfile.web`](Dockerfile.web) / [`Dockerfile.api`](Dockerfile.api) | Node 22 images for the web app and the API |
| [`Caddyfile`](Caddyfile) | HTTPS for both hostnames |

**Operate:** `cd /opt/automation-restaurant/deploy/vultr`, then `docker compose ps`,
`docker compose logs -f api`, or `docker compose up -d --build` after an update.

## What's next on Vultr

- **Vultr Serverless Inference** as an AI provider: the API already supports more than one
  model provider, so Vultr's OpenAI-compatible endpoint can be added next to Gemini.
- **Vultr Managed Databases** for the central registry, and a second VM behind a load
  balancer as restaurants grow.
