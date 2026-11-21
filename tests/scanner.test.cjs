const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function scanner(fetch) {
  const source = fs.readFileSync(path.join(__dirname, '../sistema-central/public/admin/admin.js'), 'utf8');
  const elements = { 'qr-token-input': { value: '' }, 'qr-verification-result': { className: '', innerHTML: '' } };
  const warnings = [];
  const context = {
    document: { getElementById: id => elements[id] }, fetch,
    playTone: tone => warnings.push(tone), showAlreadyScanned() {},
    escapeHtml: value => String(value || ''), sourceBadge: () => '',
    formatDateTime: value => value, fetchAdminOverview() {}, AbortSignal
  };
  vm.createContext(context);
  vm.runInContext('let qrVerificationBusy = false;\n' + source.slice(source.indexOf('async function verifyQrToken('), source.indexOf('// Popup when')), context);
  return { context, elements, warnings };
}
const order = token => ({ ticket_number: token, verification_token: token, buyer_name: token });
const response = value => ({ json: async () => value });

test('camera frames cannot overlap verification or change the active result', async () => {
  let resolveFirst;
  const requests = [];
  const { context, elements } = scanner(async (url, options) => {
    requests.push(url);
    const token = url.split('/')[4];
    if (options.method === 'POST') return response({ ok: true, order: { ...order(token), checked_in_at: '2026-11-21 19:00:00' } });
    if (token === 'A') await new Promise(resolve => { resolveFirst = resolve; });
    return response({ valid: true, order: order(token) });
  });
  const first = context.verifyQrToken('A', { register: true });
  await context.verifyQrToken('B', { register: true });
  assert.equal(requests.length, 1);
  assert.equal(elements['qr-token-input'].value, 'A');
  resolveFirst();
  await first;
  assert.match(elements['qr-verification-result'].innerHTML, /INGRESO REGISTRADO/);
  await context.verifyQrToken('B', { register: true });
  assert.match(elements['qr-verification-result'].innerHTML, /ENTRADA #B/);
  assert.equal(requests.length, 4);
});

test('failed check-in is amber and manual retry renders a confirmed arrival', async () => {
  let fail = true;
  const { context, elements, warnings } = scanner(async (_url, options) => {
    if (options.method !== 'POST') return response({ valid: true, order: order('A') });
    return response(fail ? { ok: false, message: 'No se pudo guardar' } :
      { ok: true, order: { ...order('A'), checked_in_at: '2026-11-21 19:00:00' } });
  });
  await context.verifyQrToken('A', { register: true });
  assert.match(elements['qr-verification-result'].className, /amber/);
  assert.match(elements['qr-verification-result'].innerHTML, /INGRESO PENDIENTE/);
  assert.doesNotMatch(elements['qr-verification-result'].innerHTML, /QR VÁLIDO Y AUTÉNTICO/);
  assert.equal(warnings.at(-1), 'invalid');
  fail = false;
  const button = { dataset: { token: 'A' }, disabled: false };
  await context.checkInAttendee(button);
  assert.match(elements['qr-verification-result'].innerHTML, /INGRESO REGISTRADO/);
  assert.equal(button.disabled, false);
});

test('connection failure clears the success color and allows the next scan', async () => {
  let fail = true;
  const { context, elements } = scanner(async () => {
    if (fail) throw new Error('offline');
    return response({ valid: false, message: 'Token inexistente' });
  });
  await context.verifyQrToken('A', { register: true });
  assert.match(elements['qr-verification-result'].className, /red/);
  assert.match(elements['qr-verification-result'].innerHTML, /INGRESO SIN CONFIRMAR/);
  fail = false;
  await context.verifyQrToken('B', { register: true });
  assert.match(elements['qr-verification-result'].innerHTML, /Token inexistente/);
});

