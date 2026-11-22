const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('assisted form explains blocked fields and submits after correction', async () => {
  const code = fs.readFileSync(path.join(__dirname, '../sistema-central/public/admin/admin.js'), 'utf8');
  let submit;
  let valid = false;
  let focused = false;
  let requests = 0;
  const status = { textContent: '', setAttribute() {}, scrollIntoView() {}, classList: { add() {}, remove() {} } };
  const field = { name: 'source', checkValidity: () => valid, validationMessage: 'Elige una página.',
    closest: () => ({ firstChild: { textContent: 'Página de origen' } }), removeAttribute() {}, setAttribute() {},
    focus() { focused = true; }, scrollIntoView() {} };
  const button = { addEventListener() {}, disabled: false };
  const form = {
    elements: { namedItem: () => field }, isConnected: false,
    querySelector: selector => selector.includes('role=') ? status : selector === 'input, textarea' ? field : button,
    querySelectorAll: selector => selector === 'input,select,textarea' ? [field] : [button],
    addEventListener(name, callback) { if (name === 'submit') submit = callback; }
  };
  const container = { innerHTML: '', querySelector: () => form, parentElement: { querySelectorAll: () => [] } };
  const context = { arbitrationActions: { assist: ['Registrar compra asistida', 'Registro del pago'] },
    escapeHtml: value => String(value || ''), AbortSignal,
    FormData: class { get() { return null; } delete() {} set() {} },
    fetch: async () => { requests++; return { ok: true, json: async () => ({ ok: true, message: 'Pago registrado' }) }; },
    showToast() {}, fetchAdminOverview() {}
  };
  vm.createContext(context);
  vm.runInContext(code.slice(code.indexOf('function renderArbitrationForm('), code.indexOf('// ORDER REVIEW:')), context);
  context.renderArbitrationForm(container, '/endpoint', '250', { revision: 'abc' }, 'assist');
  assert.match(container.innerHTML, /novalidate/);
  assert.match(container.innerHTML, /Compra asistida desde el mapa/);
  await submit({ preventDefault() {} });
  assert.equal(requests, 0);
  assert.match(status.textContent, /Página de origen/);
  assert.equal(focused, true);
  valid = true;
  await submit({ preventDefault() {} });
  assert.equal(requests, 1);
  assert.equal(button.disabled, false);
});
