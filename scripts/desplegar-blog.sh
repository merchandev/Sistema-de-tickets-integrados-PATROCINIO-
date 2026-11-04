#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /docker/socials-entradas
backup="backups/blog-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup"
export SOCIALS_BLOG_BACKUP="$backup"
python3 - <<'PY'
import json, os, pathlib, shutil, sqlite3, subprocess
backup = pathlib.Path(os.environ['SOCIALS_BLOG_BACKUP'])
ids = subprocess.check_output(['docker','ps','-aq'],text=True).split()
containers = json.loads(subprocess.check_output(['docker','inspect',*ids],text=True))
others = []
for c in containers:
    if c['Name'] not in ['/socials-entradas-sistema-central-1','/socials-entradas-pagina-web-2-1']:
        others.append({'id':c['Id'],'name':c['Name'],'started':c['State']['StartedAt'],'ports':c['HostConfig']['PortBindings']})
    if c['Name'] == '/socials-entradas-sistema-central-1':
        for mount in c['Mounts']:
            if mount['Destination'] == '/app/data':
                db = pathlib.Path(mount['Source'])/'entradas.sqlite'
                with sqlite3.connect(f'file:{db}?mode=ro',uri=True) as src, sqlite3.connect(backup/'entradas.sqlite') as dst:
                    src.backup(dst)
            elif mount['Destination'] == '/app/storage':
                shutil.copytree(mount['Source'],backup/'storage',dirs_exist_ok=True)
(backup/'unchanged-containers.json').write_text(json.dumps(others))
PY
tar --exclude=node_modules --exclude=data --exclude=storage --exclude=.env -czf "$backup/source-before.tar.gz" sistema-central pagina-web-2
tar -xzf release-blog.tar.gz
docker compose --env-file .env.domains -f compose.yaml -f compose.hostinger.yaml -f compose.domains.yaml config --quiet
docker compose --env-file .env.domains -f compose.yaml -f compose.hostinger.yaml -f compose.domains.yaml up -d --build --no-deps --wait sistema-central pagina-web-2
python3 - <<'PY'
import json, os, pathlib, subprocess
before = json.loads(pathlib.Path(os.environ['SOCIALS_BLOG_BACKUP'],'unchanged-containers.json').read_text())
for expected in before:
    c = json.loads(subprocess.check_output(['docker','inspect',expected['id']],text=True))[0]
    assert c['State']['StartedAt'] == expected['started'], expected['name']
    assert c['HostConfig']['PortBindings'] == expected['ports'], expected['name']
print(f'Verificados {len(before)} contenedores sin cambios, incluida Iluminando Caminos.')
PY
printf 'Backup: %s\n' "$backup"
