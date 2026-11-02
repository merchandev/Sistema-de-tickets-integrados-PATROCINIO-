#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /docker/socials-entradas
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="/docker/socials-entradas/backups/$stamp"
mkdir -p "$backup"
export SOCIALS_BACKUP_DIR="$backup"
python3 - <<'PY'
import json, os, pathlib, shutil, sqlite3, subprocess
root = pathlib.Path('/docker/socials-entradas')
backup = pathlib.Path(os.environ['SOCIALS_BACKUP_DIR'])
for name in ['compose.yaml','compose.hostinger.yaml','compose.domains.yaml','.env.domains','.env.docker','.web-proxy-key']:
    if (root/name).exists(): shutil.copy2(root/name, backup/name)
ids = subprocess.check_output(['docker','ps','-aq'],text=True).split()
containers = json.loads(subprocess.check_output(['docker','inspect',*ids],text=True))
others = []
for c in containers:
    if (c['Config'].get('Labels') or {}).get('com.docker.compose.project') != 'socials-entradas':
        others.append({'id':c['Id'],'name':c['Name'],'started':c['State']['StartedAt'],'ports':c['HostConfig'].get('PortBindings')})
    elif c['Name'] == '/socials-entradas-sistema-central-1':
        for mount in c['Mounts']:
            if mount['Destination'] == '/app/data':
                database = pathlib.Path(mount['Source'])/'entradas.sqlite'
                if database.exists():
                    with sqlite3.connect(f'file:{database}?mode=ro',uri=True) as source, sqlite3.connect(backup/'entradas.sqlite') as dest:
                        source.backup(dest)
            elif mount['Destination'] == '/app/storage':
                shutil.copytree(mount['Source'],backup/'storage',dirs_exist_ok=True)
(backup/'other-projects-before.json').write_text(json.dumps(others,indent=2))
PY
tar --exclude=node_modules --exclude=data --exclude=storage --exclude=.env -czf "$backup/source-before.tar.gz" sistema-central pagina-web-1 pagina-web-2
tar -xzf release-production.tar.gz
docker compose --env-file .env.domains -f compose.yaml -f compose.hostinger.yaml -f compose.domains.yaml config --quiet
docker compose --env-file .env.domains -f compose.yaml -f compose.hostinger.yaml -f compose.domains.yaml up -d --build --wait
docker compose --env-file .env.domains -f compose.yaml -f compose.hostinger.yaml -f compose.domains.yaml ps
printf 'Backup de este despliegue: %s\n' "$backup"
