#!/usr/bin/env bash
# Deploys Automation Restaurant (web + api + HTTPS) on a fresh Vultr Ubuntu VM.
#
#   curl -fsSL https://raw.githubusercontent.com/shiraz-eng/Automation-Restaurant-1/main/deploy/vultr/deploy.sh | bash
#   bash /opt/automation-restaurant/deploy/vultr/deploy.sh [your-domain]      # re-run / update
#
# With no domain, it uses <server-ip>.sslip.io (a free hostname that points at
# this server) for the site and api.<server-ip>.sslip.io for the API. Run as root.
set -euo pipefail

REPO="https://github.com/shiraz-eng/Automation-Restaurant-1.git"
DIR="/opt/automation-restaurant"
HERE="$DIR/deploy/vultr"

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo -i)."; exit 1; }

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  # Docker's installer only knows released Ubuntu versions; on a newer one use Ubuntu's own packages.
  if ! curl -fsSL https://get.docker.com | sh; then
    apt-get update -y
    apt-get install -y docker.io docker-compose-v2 || apt-get install -y docker.io docker-compose-plugin
    systemctl enable --now docker
  fi
fi
docker compose version >/dev/null 2>&1 || { echo "Docker Compose is missing: apt-get install -y docker-compose-v2"; exit 1; }
command -v git >/dev/null 2>&1 || { apt-get update -y && apt-get install -y git; }

# Building Next.js needs memory: add swap on small plans.
if [ "$(swapon --show | wc -l)" = 0 ] && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 6000000 ]; then
  say "Adding a 4 GB swap file"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [ -d "$DIR/.git" ]; then
  say "Updating the code"
  git -C "$DIR" pull --ff-only
elif [ -f "$DIR/package.json" ]; then
  # A private repository: the code was uploaded (git archive | ssh … tar -x).
  say "Using the uploaded code in $DIR"
else
  say "Downloading the code"
  git clone --depth 1 "$REPO" "$DIR"
fi

if [ ! -f "$HERE/api.env" ] || [ ! -f "$HERE/web.env" ]; then
  IP="$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')"
  cat <<EOF

Almost there. Copy your two env files to this server, then run this script again.
From PowerShell on your PC, in the "Restaurant Software" folder:

  scp apps\\api\\.env root@$IP:$HERE/api.env
  scp apps\\web\\.env.local root@$IP:$HERE/web.env

Then on the server:  bash $HERE/deploy.sh
EOF
  exit 1
fi

IP="$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')"
DOMAIN="${1:-${IP//./-}.sslip.io}"
API_DOMAIN="api.$DOMAIN"
val() { grep -E "^$1=" "$HERE/web.env" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

say "Settings for $DOMAIN"
cat > "$HERE/.env" <<EOF
DOMAIN=$DOMAIN
API_DOMAIN=$API_DOMAIN
NEXT_PUBLIC_CONTROL_PLANE_URL=$(val NEXT_PUBLIC_CONTROL_PLANE_URL)
NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY=$(val NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY)
EOF
# The web app's own AI routes (AI Guide, menu assistant) need only the Gemini settings, not every API secret.
{ cat "$HERE/web.env"; echo; grep -E '^GEMINI_(API_KEY|MODEL)=' "$HERE/api.env" || true; } > "$HERE/web.runtime.env"
chmod 600 "$HERE/.env" "$HERE/api.env" "$HERE/web.env" "$HERE/web.runtime.env"

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q active; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
fi

say "Building and starting (the first build takes 5-10 minutes)"
cd "$HERE"
docker compose up -d --build

say "Waiting for the API"
for _ in $(seq 1 60); do
  if curl -fsS "https://$API_DOMAIN/health" >/dev/null 2>&1; then break; fi
  sleep 5
done

cat <<EOF

Automation Restaurant is running on this Vultr server:
  Website:  https://$DOMAIN
  API:      https://$API_DOMAIN/health
  Logs:     cd $HERE && docker compose logs -f
EOF
