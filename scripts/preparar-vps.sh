#!/usr/bin/env bash
set -euo pipefail
cd /docker/socials-entradas
tar -xzf source.tar.gz
python3 - <<'PY'
from pathlib import Path
import secrets
env = Path('.env.docker')
if not env.exists():
    env.write_text('ADMIN_USER=admin\nADMIN_PASSWORD=' + secrets.token_hex(24) + '\n')
env.chmod(0o600)
key = Path('.web-proxy-key')
if not key.exists():
    key.write_text(secrets.token_hex(32))
key.chmod(0o600)
key.chown(1000, 1000)  # Node containers run as UID 1000, not root.
PY
docker compose -f compose.yaml -f compose.hostinger.yaml up -d --build --wait
docker compose -f compose.yaml -f compose.hostinger.yaml ps
