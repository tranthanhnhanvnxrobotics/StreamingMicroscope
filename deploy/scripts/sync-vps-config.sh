#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GLOBAL_ENV="${ROOT_DIR}/.env.global"
NGINX_TEMPLATE="${ROOT_DIR}/deploy/nginx/webapp-ip.conf.template"
NGINX_RENDERED="${ROOT_DIR}/deploy/nginx/webapp-ip.conf"
BACKEND_ENV="${ROOT_DIR}/backend/.env"
FRONTEND_ENV="${ROOT_DIR}/frontend/.env.production"

if [[ ! -f "${GLOBAL_ENV}" ]]; then
  echo "[ERR] Missing ${GLOBAL_ENV}"
  echo "Copy ${ROOT_DIR}/.env.global.example -> ${GLOBAL_ENV} and update values."
  exit 1
fi

set -a
source "${GLOBAL_ENV}"
set +a

: "${VPS_IP:?VPS_IP is required in .env.global}"
API_PORT="${API_PORT:-5000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
WHEP_PORT="${WHEP_PORT:-8889}"

if ! command -v envsubst >/dev/null 2>&1; then
  echo "[ERR] envsubst not found. Install with: apt install -y gettext-base"
  exit 1
fi

if [[ ! -f "${NGINX_TEMPLATE}" ]]; then
  echo "[ERR] Missing nginx template: ${NGINX_TEMPLATE}"
  exit 1
fi

echo "[1/3] Rendering nginx config..."
envsubst '${VPS_IP} ${API_PORT} ${FRONTEND_PORT}' < "${NGINX_TEMPLATE}" > "${NGINX_RENDERED}"

echo "[2/3] Writing frontend .env.production..."
cat > "${FRONTEND_ENV}" <<EOF
NEXT_PUBLIC_SOCKET_URL=http://${VPS_IP}
NEXT_PUBLIC_SOCKET_TOKEN=${SOCKET_AUTH_TOKEN:-change_me_long_random_token}
NEXT_PUBLIC_WHEP_URL=http://${VPS_IP}:${WHEP_PORT}/cam1/whep
EOF

echo "[3/3] Updating backend .env..."
if [[ ! -f "${BACKEND_ENV}" ]]; then
  cp "${ROOT_DIR}/backend/.env.vps.example" "${BACKEND_ENV}"
fi

if grep -q '^FRONTEND_ORIGIN=' "${BACKEND_ENV}"; then
  sed -i "s|^FRONTEND_ORIGIN=.*$|FRONTEND_ORIGIN=http://${VPS_IP}|" "${BACKEND_ENV}"
else
  echo "FRONTEND_ORIGIN=http://${VPS_IP}" >> "${BACKEND_ENV}"
fi

if grep -q '^PORT=' "${BACKEND_ENV}"; then
  sed -i "s|^PORT=.*$|PORT=${API_PORT}|" "${BACKEND_ENV}"
else
  echo "PORT=${API_PORT}" >> "${BACKEND_ENV}"
fi

if [[ -n "${SOCKET_AUTH_TOKEN:-}" ]]; then
  if grep -q '^SOCKET_AUTH_TOKEN=' "${BACKEND_ENV}"; then
    sed -i "s|^SOCKET_AUTH_TOKEN=.*$|SOCKET_AUTH_TOKEN=${SOCKET_AUTH_TOKEN}|" "${BACKEND_ENV}"
  else
    echo "SOCKET_AUTH_TOKEN=${SOCKET_AUTH_TOKEN}" >> "${BACKEND_ENV}"
  fi
fi

if [[ -n "${PI_AGENT_TOKEN:-}" ]]; then
  if grep -q '^PI_AGENT_TOKEN=' "${BACKEND_ENV}"; then
    sed -i "s|^PI_AGENT_TOKEN=.*$|PI_AGENT_TOKEN=${PI_AGENT_TOKEN}|" "${BACKEND_ENV}"
  else
    echo "PI_AGENT_TOKEN=${PI_AGENT_TOKEN}" >> "${BACKEND_ENV}"
  fi
fi

echo "Done. Updated:"
echo "- ${FRONTEND_ENV}"
echo "- ${BACKEND_ENV}"
echo "- ${NGINX_RENDERED}"

echo
echo "Next:"
echo "sudo cp ${NGINX_RENDERED} /etc/nginx/sites-available/webapp"
echo "sudo ln -sf /etc/nginx/sites-available/webapp /etc/nginx/sites-enabled/webapp"
echo "sudo nginx -t && sudo systemctl reload nginx"
echo "cd ${ROOT_DIR}/frontend && npm run build"
echo "cd ${ROOT_DIR} && pm2 restart backend frontend"
