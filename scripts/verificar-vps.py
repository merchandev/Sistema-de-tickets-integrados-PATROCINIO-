#!/usr/bin/env python3
"""Read health/state and test an exclusive reservation, always releasing it."""
import base64
import concurrent.futures
import json
from pathlib import Path
import urllib.error
import urllib.request
import uuid

def request(base, path, body=None, headers=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data,
        headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as err:
        return err.code, json.load(err)

central = 'http://127.0.0.1:4000'
webs = ['http://127.0.0.1:3001', 'http://127.0.0.1:3002']
for base in [central, *webs]:
    assert request(base, '/health')[0] == 200
assert request(central, '/api/admin/overview')[0] == 401
states = [request(web, '/api/public/state')[1] for web in webs]
assert all(len(state['tickets']) == 250 for state in states)
assert states[0]['config']['ticket_price_ves'] == states[1]['config']['ticket_price_ves']
assert states[0]['config']['bcv_is_official']
number = next(ticket['ticket_number'] for ticket in states[0]['tickets'] if ticket['status'] == 'AVAILABLE')
sessions = ['vps-check-' + uuid.uuid4().hex for _ in webs]
def reserve(index):
    return request(webs[index], '/api/public/tickets/lock', {
        'ticket_number': number, 'session_id': sessions[index], 'source_web': 'pagina-web-' + str(index + 1)})
results = []
sales_closed = all(state['config'].get('sales_enabled') is False for state in states)
try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(reserve, range(2)))
    if sales_closed:
        assert all(status == 503 and body.get('code') == 'SALES_NOT_OPEN' for status, body in results), results
    else:
        assert sorted(status for status, _ in results) == [200, 409], results
        assert all(next(t for t in request(web, '/api/public/state')[1]['tickets'] if t['ticket_number'] == number)['status'] == 'LOCKED' for web in webs)
        winner = next(i for i, result in enumerate(results) if result[0] == 200)
        assert results[winner][1]['ticket']['locked_by_source'] == 'pagina-web-' + str(winner + 1)
finally:
    for index, result in enumerate(results):
        if result[0] == 200:
            request(webs[index], '/api/public/tickets/unlock', {'ticket_number': number, 'session_id': sessions[index]})

env = dict(line.split('=', 1) for line in Path('/docker/socials-entradas/.env.docker').read_text().splitlines() if '=' in line)
auth = base64.b64encode((env['ADMIN_USER'] + ':' + env['ADMIN_PASSWORD']).encode()).decode()
status, admin = request(central, '/api/admin/overview', headers={'Authorization': 'Basic ' + auth})
assert status == 200
output = {'ok': True, 'checks': ['health-3-services', 'admin-auth', '250-tickets', 'shared-price', 'official-bcv', *(['sales-not-open-503'] if sales_closed else ['concurrent-reservation-200-409', 'shared-state', 'source-tracking', 'reservation-released'])],
    'counts': admin['counts'], 'bcv': {key: states[0]['config'].get(key) for key in ['bcv_rate', 'bcv_source_url', 'bcv_value_date', 'ticket_price_ves']}}
print(json.dumps(output, ensure_ascii=False))
