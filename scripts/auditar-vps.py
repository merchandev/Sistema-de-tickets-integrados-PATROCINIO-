#!/usr/bin/env python3
"""Read-only Docker inventory. Prints no environment variables or credentials."""
import datetime
import json
import subprocess

def command(*args):
    return subprocess.check_output(args, text=True).strip()

ids = command('docker', 'ps', '-aq').splitlines()
containers = json.loads(command('docker', 'inspect', *ids)) if ids else []
inventory = []
for container in containers:
    labels = container['Config'].get('Labels') or {}
    name = container['Name'].lstrip('/')
    project = labels.get('com.docker.compose.project', '(outside-compose)')
    inventory.append({
        'name': name, 'project': project,
        'state': container['State']['Status'],
        'health': container['State'].get('Health', {}).get('Status'),
        'ports': container['HostConfig'].get('PortBindings') or {},
        'network_mode': container['HostConfig'].get('NetworkMode'),
        'networks': sorted(container['NetworkSettings']['Networks']),
        'mounts': [{'type': mount['Type'], 'source': mount.get('Name') or mount['Source'], 'destination': mount['Destination'], 'rw': mount['RW']} for mount in container['Mounts']],
        'proxy': {key: value for key, value in labels.items() if key == 'traefik.enable' or (key.startswith('traefik.http.') and key.endswith(('.rule', '.entrypoints', '.server.port', '.certresolver')))},
        'resources': {key: container['HostConfig'].get(key) for key in ['Memory', 'NanoCpus', 'PidsLimit']},
        'restart': container['HostConfig']['RestartPolicy']['Name'],
        'user': container['Config'].get('User'),
        'privileged': container['HostConfig']['Privileged'],
        'compose_files': labels.get('com.docker.compose.project.config_files'),
    })

project = [item for item in inventory if item['project'] == 'socials-entradas']
others = [item for item in inventory if item['project'] != 'socials-entradas']
findings = []
for item in project:
    for bindings in item['ports'].values():
        for binding in bindings or []:
            if binding.get('HostIp') not in ('127.0.0.1', '::1'):
                findings.append({'type': 'non_loopback_port', 'container': item['name'], 'binding': binding})
            for other in others:
                for other_bindings in other['ports'].values():
                    for other_binding in other_bindings or []:
                        if binding['HostPort'] == other_binding['HostPort']:
                            findings.append({'type': 'shared_port_number', 'container': item['name'], 'other': other['name'], 'binding': binding, 'other_binding': other_binding})
    for mount in item['mounts']:
        if mount['type'] == 'volume':
            for other in others:
                if any(other_mount['source'] == mount['source'] for other_mount in other['mounts']):
                    findings.append({'type':'shared_volume', 'container':item['name'], 'other':other['name'], 'volume':mount['source']})
    if item['privileged']:
        findings.append({'type': 'privileged', 'container': item['name']})
    if any(mount['destination'] == '/var/run/docker.sock' for mount in item['mounts']):
        findings.append({'type': 'docker_socket', 'container': item['name']})
    if not item['resources']['Memory'] or not item['resources']['NanoCpus']:
        findings.append({'type':'resource_limits_not_configured', 'container':item['name']})

print(json.dumps({
    'date': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'compose_projects': json.loads(command('docker', 'compose', 'ls', '-a', '--format', 'json')),
    'inventory': inventory,
    'project_count': len(project),
    'findings': findings,
    'listeners': command('ss', '-ltnp'),
}, ensure_ascii=False, indent=2))
