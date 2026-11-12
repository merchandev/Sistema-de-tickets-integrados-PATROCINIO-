// Payment control sheet in Google Sheets (integraciones/google-sheets/Codigo.gs).
// Send reported payments to Apps Script. The team manages both validations in the sheet.
const { db, getAllSettings, updateSettings } = require('./db');

const SITE_NAMES = { 'pagina-web-1': 'Iluminando Caminos', 'pagina-web-2': 'Hablemos de Marketing' };
const WEB_APP_URL = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]{20,}\/exec$/;
const SHEET_URL = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[\w-]{20,}(\/[^\s]*)?$/;
const BATCH = 100;

// Tests point the integration at a local imitation of the web app
const validWebAppUrl = (url) => WEB_APP_URL.test(url) || (process.env.SHEETS_TEST_URLS === '1' && /^http:\/\/127\.0\.0\.1:\d+\//.test(url));
const validSheetUrl = (url) => SHEET_URL.test(url);

function config(settings = getAllSettings()) {
  const url = String(settings.sheets_webapp_url || '').trim();
  const key = String(settings.sheets_secret || '').trim();
  return { url, key, configured: Boolean(url && key && validWebAppUrl(url)) };
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(String(value).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? '' : 'Z'));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('es-VE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Caracas' }).format(date);
}

function toRow(order) {
  const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return {
    id: order.id,
    fecha: formatDate(order.created_at),
    pagina: SITE_NAMES[order.source_web] || order.source_web || '',
    entrada: order.ticket_number ? `#${order.ticket_number}` : `Por asignar${order.requested_ticket ? ` (pidió #${order.requested_ticket})` : ''}`,
    nombre: order.buyer_name || '',
    cedula: order.buyer_cedula || '',
    telefono: order.buyer_phone || '',
    correo: order.buyer_email || '',
    banco: order.payment_bank || '',
    referencia: order.payment_reference || '',
    montoBs: Number(order.amount_ves) || 0,
    montoUsd: Number(order.amount_usd) || 0,
    tasa: Number(order.bcv_rate) || 0,
    comprobante: order.screenshot_path && base ? base + order.screenshot_path : '',
    comentario: order.buyer_comment || ''
  };
}

async function post(body, settings) {
  const { url, key, configured } = config(settings);
  if (!configured) return { ok: false, message: 'La hoja de Google no está configurada.' };
  try {
    // Apps Script answers with a redirect to the result, which fetch follows
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clave: key, ...body }),
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return { ok: false, message: `La hoja respondió algo inesperado (HTTP ${res.status}). Revisa que la implementación sea «Aplicación web» con acceso «Cualquier usuario».` };
    }
    return data.ok ? { ok: true, ...data } : { ok: false, message: data.error || 'La hoja rechazó la solicitud.' };
  } catch (err) {
    return { ok: false, message: err.name === 'TimeoutError' ? 'La hoja de Google no respondió a tiempo.' : `No se pudo contactar la hoja: ${err.message}` };
  }
}

function remember(result, what) {
  const line = `${new Date().toISOString()} · ${what}: ${result.ok ? 'enviado' : result.message}`;
  try { updateSettings({ sheets_last_status: line.slice(0, 300) }); } catch { /* never blocks a payment */ }
  console.log(`[Hoja] ${what} -> ${result.ok ? 'OK' : `ERROR: ${result.message}`}`);
}

/** Sends one order in the background; a failure is logged and never affects the payment flow. */
function syncOrder(order) {
  if (!order || !config().configured) return;
  post({ accion: 'pedidos', pedidos: [toRow(order)] })
    .then(result => remember(result, `pago #${order.id}`))
    .catch(err => remember({ ok: false, message: err.message }, `pago #${order.id}`));
}

async function testConnection() {
  const result = await post({ accion: 'prueba' });
  return result.ok
    ? { ok: true, message: `Conexión correcta con la hoja «${result.hoja}» (${result.filas} pago(s) registrados).` }
    : result;
}

/** Backfills missing payments through a version that skips existing rows by ID. */
async function syncAll() {
  const connection = await post({ accion: 'prueba' });
  if (!connection.ok) return connection;
  if (connection.soloNuevos !== true) {
    return { ok: false, message: 'Publica la versión actual de Apps Script para copiar pagos faltantes sin modificar filas existentes.' };
  }
  const orders = db.prepare('SELECT * FROM orders ORDER BY id').all();
  let nuevas = 0;
  let existentes = 0;
  for (let i = 0; i < orders.length; i += BATCH) {
    const result = await post({ accion: 'pedidos', pedidos: orders.slice(i, i + BATCH).map(toRow) });
    if (!result.ok) {
      remember(result, 'envío completo');
      return { ok: false, message: `${result.message} Se revisaron ${nuevas + existentes} de ${orders.length} pagos.` };
    }
    nuevas += result.nuevas || 0;
    existentes += result.existentes || 0;
  }
  const done = { ok: true, message: `Hoja al día. Pagos agregados: ${nuevas}. Filas existentes: ${existentes}.` };
  remember(done, 'envío completo');
  return done;
}

module.exports = { syncOrder, syncAll, testConnection, validWebAppUrl, validSheetUrl, toRow };
