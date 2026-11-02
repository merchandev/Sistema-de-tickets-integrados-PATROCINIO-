#!/usr/bin/env bash
# Deploy the two public frontends without recreating the central system.
set -euo pipefail
umask 077
cd /docker/socials-entradas
backup="backups/webs-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup"
export SOCIALS_WEB_BACKUP="$backup"
python3 - <<'PY'
import json, os, pathlib, subprocess
ids = subprocess.check_output(['docker', 'ps', '-aq'], text=True).split()
containers = json.loads(subprocess.check_output(['docker', 'inspect', *ids], text=True))
snapshot = [{'id': c['Id'], 'name': c['Name'], 'started': c['State']['StartedAt'], 'ports': c['HostConfig']['PortBindings']}
            for c in containers if c['Name'] not in ['/socials-entradas-pagina-web-1-1', '/socials-entradas-pagina-web-2-1']]
pathlib.Path(os.environ['SOCIALS_WEB_BACKUP'], 'unchanged-containers.json').write_text(json.dumps(snapshot))
PY
tar -czf "$backup/webs-before.tar.gz" pagina-web-1/public pagina-web-2/public
tar -xzf release-webs.tar.gz
docker compose --env-file .env.domains -f compose.yaml -f compose.hostinger.yaml -f compose.domains.yaml config --quiet
docker compose --env-file .env.domains -f compose.yaml -f compose.hostinger.yaml -f compose.domains.yaml up -d --build --no-deps --wait pagina-web-1 pagina-web-2
python3 - <<'PY'
import json, os, pathlib, subprocess
before = json.loads(pathlib.Path(os.environ['SOCIALS_WEB_BACKUP'], 'unchanged-containers.json').read_text())
for expected in before:
    c = json.loads(subprocess.check_output(['docker', 'inspect', expected['id']], text=True))[0]
    assert c['State']['StartedAt'] == expected['started'], expected['name']
    assert c['HostConfig']['PortBindings'] == expected['ports'], expected['name']
print(f'Verificados {len(before)} contenedores sin cambios (incluidos central y correo).')
PY
printf 'Backup: %s\n' "$backup"
