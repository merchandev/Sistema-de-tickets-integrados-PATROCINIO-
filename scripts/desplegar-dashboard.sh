#!/usr/bin/env bash
# Replace only the dashboard assets and recreate only the central container.
set -euo pipefail
umask 077
cd /docker/socials-entradas
backup="backups/dashboard-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup"
export SOCIALS_ADMIN_BACKUP="$backup"
python3 - <<'PY'
import json, os, pathlib, sqlite3, subprocess
ids = subprocess.check_output(['docker', 'ps', '-aq'], text=True).split()
containers = json.loads(subprocess.check_output(['docker', 'inspect', *ids], text=True))
snapshot = []
for c in containers:
    if c['Name'] != '/socials-entradas-sistema-central-1':
        snapshot.append({'id': c['Id'], 'name': c['Name'], 'started': c['State']['StartedAt'], 'ports': c['HostConfig']['PortBindings']})
    else:
        for mount in c['Mounts']:
            if mount['Destination'] == '/app/data':
                db = pathlib.Path(mount['Source']) / 'entradas.sqlite'
                with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as src, sqlite3.connect(pathlib.Path(os.environ['SOCIALS_ADMIN_BACKUP']) / 'entradas.sqlite') as dst:
                    src.backup(dst)
pathlib.Path(os.environ['SOCIALS_ADMIN_BACKUP'], 'unchanged-containers.json').write_text(json.dumps(snapshot))
PY
tar -czf "$backup/admin-before.tar.gz" sistema-central/public/admin
tar -xzf release-dashboard.tar.gz
docker compose --env-file .env.domains -f compose.yaml -f compose.hostinger.yaml -f compose.domains.yaml config --quiet
docker compose --env-file .env.domains -f compose.yaml -f compose.hostinger.yaml -f compose.domains.yaml up -d --build --no-deps --wait sistema-central
python3 - <<'PY'
import json, os, pathlib, subprocess
before = json.loads(pathlib.Path(os.environ['SOCIALS_ADMIN_BACKUP'], 'unchanged-containers.json').read_text())
for expected in before:
    c = json.loads(subprocess.check_output(['docker', 'inspect', expected['id']], text=True))[0]
    assert c['State']['StartedAt'] == expected['started'], expected['name']
    assert c['HostConfig']['PortBindings'] == expected['ports'], expected['name']
print(f'Verificados {len(before)} contenedores sin cambios (incluidas ambas webs).')
PY
printf 'Backup: %s\n' "$backup"
