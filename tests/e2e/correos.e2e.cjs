// End-to-end check of tickets + emails against a real local SMTP server (smtp-sink.cjs).
// Starts its own central system on a fresh database and a generated admin password, so it never
// touches local or production data. Run with: npm run test:e2e
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..', '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-correos-'));
const central = path.join(root, 'sistema-central');
const ticketsDir = path.join(central, 'storage', 'tickets');
const ticketsBefore = new Set(fs.existsSync(ticketsDir) ? fs.readdirSync(ticketsDir) : []);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-entradas-'));
const mailDir = path.join(work, 'e2e-mail');
fs.rmSync(mailDir, { recursive: true, force: true });
const PORT = 4400;
const SMTP_PORT = 2526;
const BASE = `http://127.0.0.1:${PORT}`;
const password = crypto.randomBytes(12).toString('hex');
const basic = 'Basic ' + Buffer.from(`admin:${password}`).toString('base64');
let libmime = null;
try { libmime = require(path.join(central, 'node_modules', 'libmime')); } catch (_) {}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const sink = spawn(process.execPath, [path.join(__dirname, 'smtp-sink.cjs'), mailDir, String(SMTP_PORT)], { stdio: 'ignore' });
const server = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
  cwd: central,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_USER: 'admin', ADMIN_PASSWORD: password, PUBLIC_BASE_URL: BASE, SALES_ENABLED: 'true', BLOG_STORAGE_DIR: path.join(dataDir, 'storage') },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

async function api(method, url, { json, form, admin = false, cookie } = {}) {
  const headers = {};
  if (admin) headers.authorization = basic;
  if (cookie) headers.cookie = cookie;
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const started = Date.now();
  const res = await fetch(BASE + url, { method, headers, body, redirect: 'manual' });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers, ms: Date.now() - started };
}
// Every field of the popup is required, the capture included; pass null to leave one out
const CAPTURE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const buyerForm = (fields = {}) => {
  const form = new FormData();
  const values = {
    buyer_first_name: 'Ana', buyer_last_name: 'Rodríguez', buyer_cedula: 'V-21456789', buyer_phone: '0414-5550101',
    buyer_email: 'ana@prueba.test', payment_bank: 'Banesco (0134)', payment_reference: String(Date.now()).slice(-8),
    source_web: 'pagina-web-1', requested_ticket: '200', buyer_comment: 'La reserva expiró antes de enviar el pago',
    screenshot: true, ...fields
  };
  for (const [k, v] of Object.entries(values)) {
    if (v === null) continue;
    if (k === 'screenshot') form.append('screenshot', new Blob([CAPTURE_PNG], { type: 'image/png' }), 'captura.png');
    else form.append(k, v);
  }
  return form;
};

const mailFiles = () => (fs.existsSync(mailDir) ? fs.readdirSync(mailDir).filter(f => f.endsWith('.eml')).sort() : []);
async function waitMails(count, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end && mailFiles().length < count) await sleep(100);
  return mailFiles().length;
}
function parseMail(file) {
  const raw = fs.readFileSync(path.join(mailDir, file), 'utf8');
  const head = raw.split('\r\n\r\n')[0].replace(/\r\n[ \t]+/g, ' ');
  const header = (name) => (new RegExp(`^${name}: (.*)$`, 'mi').exec(head) || [])[1] || '';
  const subject = libmime ? libmime.decodeWords(header('Subject')) : header('Subject');
  const pdf = /Content-Type: application\/pdf[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(raw);
  return {
    file, raw, subject,
    from: libmime ? libmime.decodeWords(header('From')) : header('From'), replyTo: header('Reply-To'), messageId: header('Message-ID'),
    alternative: /multipart\/alternative/.test(raw) && /Content-Type: text\/plain/.test(raw) && /Content-Type: text\/html/.test(raw),
    pdfHeader: pdf ? Buffer.from(pdf[1].replace(/\r\n/g, ''), 'base64').subarray(0, 5).toString() : null
  };
}

(async () => {
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) {}
      await sleep(250);
    }
    check('Sistema central responde', (await fetch(`${BASE}/health`)).ok);

    // --- Sign-in ---
    const noSession = await api('GET', '/admin/');
    check('Panel sin sesión redirige al login', noSession.status === 302 && /\/admin\/login\?next=/.test(noSession.headers.get('location')));
    check('Sin ventana Basic del navegador', !noSession.headers.get('www-authenticate'));
    check('Página de login', (await api('GET', '/admin/login')).status === 200);
    check('Login incorrecto rechazado', (await api('POST', '/admin/login', { json: { username: 'admin', password: 'mal' } })).status === 401);
    const login = await api('POST', '/admin/login', { json: { username: 'admin', password, next: '/admin/' } });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    check('Login correcto crea sesión', login.status === 200 && cookie.startsWith('admin_session='));
    const session = await api('GET', '/api/admin/session', { cookie });
    check('La sesión abre la API del panel', session.status === 200 && session.data.user === 'admin');

    // --- Configuration: manual rate + real SMTP (local) ---
    const cfg = await api('PUT', '/api/admin/settings', { admin: true, json: {
      bcv_mode: 'manual', bcv_manual_rate: '891.1054', lock_duration_seconds: '600',
      smtp_host: '127.0.0.1', smtp_port: String(SMTP_PORT), smtp_user: '', smtp_from: 'Sistema de envío Espressivo Venezuela <soporte@merchan.dev>'
    } });
    check('Guardar configuración de correo', cfg.status === 200 && cfg.data.settings.smtp_delivery_mode === 'smtp' && !('smtp_pass' in cfg.data.settings));
    const state = await api('GET', '/api/public/state');
    check('Cuenta de Bancamiga publicada', state.data.config.payment_methods?.pago_movil?.telefono === '0412-2905205');

    const mailTest = await api('POST', '/api/admin/mail/test', { admin: true, json: { to: 'admin@prueba.test' } });
    check('Probar conexión SMTP y correo de prueba', mailTest.data.smtp?.ok && mailTest.data.sent?.ok, mailTest.data.sent?.message);
    await waitMails(1);

    // --- 1. Checkout from Iluminando Caminos, then approval ---
    const lock = await api('POST', '/api/public/tickets/lock', { json: { ticket_number: '210', session_id: 'sess_e2e_checkout_1', source_web: 'pagina-web-1' } });
    check('Reservar entrada #210', lock.status === 200 && /10 minutos/.test(lock.data.message), lock.data.message);
    const badOrder = await api('POST', '/api/public/orders', { form: buyerForm({ ticket_number: '210', session_id: 'sess_e2e_checkout_1', buyer_cedula: 'abc' }) });
    check('Validación de cédula', badOrder.status === 400 && badOrder.data.field === 'buyer_cedula');
    const noCapture = await api('POST', '/api/public/orders', { form: buyerForm({ ticket_number: '210', session_id: 'sess_e2e_checkout_1', screenshot: null }) });
    check('La captura del pago es obligatoria', noCapture.status === 400 && noCapture.data.field === 'screenshot', noCapture.data.message);
    const order = await api('POST', '/api/public/orders', { form: buyerForm({ ticket_number: '210', session_id: 'sess_e2e_checkout_1' }) });
    check('Enviar pago desde el popup', order.status === 201, `respuesta en ${order.ms} ms`);
    check('Respuesta rápida (correo en segundo plano)', order.ms < 1500, `${order.ms} ms`);
    await waitMails(2);

    const approve = await api('POST', `/api/admin/orders/${order.data.order.id}/approve`, { admin: true, json: {} });
    check('Aprobar pago y generar entrada', approve.status === 200 && /aceptó el correo con la entrada PDF/.test(approve.data.message), approve.data.message);
    await waitMails(3);
    const token = approve.data.order?.verification_token;

    // --- QR at the door ---
    const verify = await api('GET', `/api/admin/verify-qr/${encodeURIComponent(token)}`, { admin: true });
    check('QR válido', verify.data.valid === true);
    check('El QR nuevo usa el prefijo Espressivo', /^Espressivo-210-/.test(token));
    check('QR falso rechazado', (await api('GET', '/api/admin/verify-qr/TK-999-FALSO', { admin: true })).data.valid === false);
    const checkInUrl = `/api/admin/verify-qr/${encodeURIComponent(token)}/checkin`;
    const arrivals = await Promise.all([api('POST', checkInUrl, { admin: true }), api('POST', checkInUrl, { admin: true })]);
    check('Una sola asistencia para todo el evento incluso con solicitudes simultáneas', arrivals.map(r => r.status).sort().join(',') === '200,409');
    check('Se guarda la hora de asistencia', Boolean(arrivals.find(r => r.status === 200)?.data.order.checked_in_at));
    const qrLink = await api('GET', `/verify/${encodeURIComponent(token)}`);
    check('Enlace del QR lleva al verificador', qrLink.status === 302 && qrLink.headers.get('location').includes('verifyToken='));

    // --- 2. Payment report from Hablemos de Marketing, approved with an assigned ticket ---
    for (const [field, label] of [['requested_ticket', 'el número de entrada'], ['buyer_comment', 'qué pasó con el pago'], ['screenshot', 'la captura']]) {
      const incomplete = await api('POST', '/api/public/payment-reports', { form: buyerForm({ source_web: 'pagina-web-2', [field]: null }) });
      check(`El reporte exige ${label}`, incomplete.status === 400 && incomplete.data.field === field, incomplete.data.message);
    }
    const report = await api('POST', '/api/public/payment-reports', { form: buyerForm({ source_web: 'pagina-web-2', buyer_first_name: 'Luis', buyer_last_name: 'Martínez', buyer_email: 'luis@prueba.test', requested_ticket: '210', buyer_comment: 'Mi reserva expiró' }) });
    check('Enviar reporte de pago', report.status === 201, `respuesta en ${report.ms} ms`);
    await waitMails(4);
    check('Aprobar reporte exige entrada', (await api('POST', `/api/admin/orders/${report.data.order.id}/approve`, { admin: true, json: {} })).status === 400);
    check('No asigna una entrada vendida', (await api('POST', `/api/admin/orders/${report.data.order.id}/approve`, { admin: true, json: { ticket_number: '210' } })).status === 400);
    const approveReport = await api('POST', `/api/admin/orders/${report.data.order.id}/approve`, { admin: true, json: { ticket_number: '211' } });
    check('Aprobar reporte asignando #211', approveReport.status === 200 && approveReport.data.order.ticket_number === '211');
    await waitMails(5);

    const legacyToken = 'TK-211-12345678-ABCDEF012345';
    const legacyDb = new DatabaseSync(path.join(dataDir, 'entradas.sqlite'));
    try {
      legacyDb.prepare("UPDATE orders SET verification_token = ?, checked_in_concert = 1, checked_in_concert_at = datetime('now') WHERE id = ?")
        .run(legacyToken, approveReport.data.order.id);
    } finally { legacyDb.close(); }
    const legacyUrl = `/api/admin/verify-qr/${legacyToken}`;
    check('Una entrada con QR anterior conserva su validez', (await api('GET', legacyUrl, { admin: true })).data.valid === true);
    check('La asistencia anterior al concierto cuenta para todo el evento', (await api('POST', legacyUrl + '/checkin', { admin: true })).status === 409);

    // --- 3. Rejection ---
    await api('POST', '/api/public/tickets/lock', { json: { ticket_number: '212', session_id: 'sess_e2e_checkout_3', source_web: 'pagina-web-1' } });
    const toReject = await api('POST', '/api/public/orders', { form: buyerForm({ ticket_number: '212', session_id: 'sess_e2e_checkout_3', buyer_email: 'rechazo@prueba.test' }) });
    await waitMails(6);
    const reject = await api('POST', `/api/admin/orders/${toReject.data.order.id}/reject`, { admin: true, json: { reason: '<b>Referencia</b> no encontrada' } });
    check('Rechazar pago', reject.status === 200 && /aceptó el aviso/.test(reject.data.message), reject.data.message);
    await waitMails(7);
    const afterReject = await api('GET', '/api/public/state');
    check('La entrada rechazada vuelve a estar libre', afterReject.data.tickets.find(t => t.ticket_number === '212').status === 'AVAILABLE');

    // --- 4. Mail server down, then retry from the panel ---
    await api('PUT', '/api/admin/settings', { admin: true, json: { smtp_port: '2599' } });
    const lost = await api('POST', '/api/public/payment-reports', { form: buyerForm({ buyer_email: 'reintento@prueba.test' }) });
    check('Reporte se guarda aunque el correo falle', lost.status === 201);
    let failedLog;
    for (let i = 0; i < 80 && !failedLog; i++) {
      await sleep(250);
      const overview = await api('GET', '/api/admin/overview', { admin: true });
      failedLog = overview.data.emailLogs.find(l => l.order_id === lost.data.order.id && l.status === 'ERROR');
    }
    check('El fallo queda registrado como ERROR', Boolean(failedLog), failedLog?.error_message);
    await api('PUT', '/api/admin/settings', { admin: true, json: { smtp_port: String(SMTP_PORT) } });
    const retry = failedLog ? await api('POST', `/api/admin/mail/${failedLog.id}/retry`, { admin: true, json: {} }) : { status: 0, data: {} };
    check('Reenviar el aviso desde el panel', retry.status === 200, retry.data.message);
    await waitMails(8);
    if (failedLog) check('No se reenvía dos veces el mismo aviso', (await api('POST', `/api/admin/mail/${failedLog.id}/retry`, { admin: true, json: {} })).status === 409);

    // --- 5. Ticket design preview ---
    const demo = await api('GET', '/api/admin/tickets/demo.pdf?source=pagina-web-2', { admin: true });
    check('Vista previa de la entrada (PDF)', demo.status === 200 && demo.data.subarray(0, 5).toString() === '%PDF-');
    const pdfjs = await fetch(`${BASE}/admin/pdfjs/pdf.min.mjs`, { headers: { authorization: basic } });
    check('Visor PDF del panel', pdfjs.ok && /javascript/.test(pdfjs.headers.get('content-type') || ''), pdfjs.headers.get('content-type'));

    // --- Emails received by the SMTP server ---
    const mails = mailFiles().map(parseMail);
    check('Correos entregados al servidor SMTP', mails.length === 8, `${mails.length} de 8`);
    const expected = [
      ['Correo de prueba', /Correo de prueba/],
      ['En verificación (#210)', /^Estamos verificando tu pago$/],
      ['Entrada con PDF (#210)', /^Muchas gracias por su apoyo, tu entrada está disponible$/],
      ['En verificación (reporte)', /^Estamos verificando tu pago$/],
      ['Entrada con PDF (#211)', /^Muchas gracias por su apoyo, tu entrada está disponible$/],
      ['En verificación (#212)', /^Estamos verificando tu pago$/],
      ['Pago rechazado', /^Pago rechazado$/],
      ['Reenvío tras fallo', /^Estamos verificando tu pago$/]
    ];
    expected.forEach(([label, pattern], i) => check(`Correo: ${label}`, mails[i] && pattern.test(mails[i].subject), mails[i]?.subject));
    check('Todos con versión HTML y texto', mails.every(m => m.alternative));
    check('Remitente «Sistema de envío Espressivo Venezuela»', mails.every(m => /^"?Sistema de envío Espressivo Venezuela"? <soporte@merchan\.dev>$/.test(m.from)), mails[0]?.from);
    check('Correo de la entrada nombra el número', /#210/.test(mails[2]?.raw.replace(/=\r\n/g, '') || ''));
    check('Los correos de pago y confirmación explican el acceso a todo el evento', [1, 2, 3, 4].every(i =>
      /acceso a todo el evento|acceder a todo el evento/.test(mails[i]?.raw.replace(/=\r\n/g, '') || '')
    ));
    check('Remitente, Reply-To y Message-ID del dominio', mails.every(m => /soporte@merchan\.dev/.test(m.from) && /soporte@merchan\.dev/.test(m.replyTo) && /@merchan\.dev>$/.test(m.messageId)));
    check('Las entradas llevan el PDF adjunto', [mails[2], mails[4]].every(m => m?.pdfHeader === '%PDF-'));
    // The HTML part must escape the reason; the plain-text part shows it literally, as plain text should.
    const htmlPart = (mails[6]?.raw.split(/\r\n--[^\r\n]+\r\n/).find(p => /Content-Type: text\/html/.test(p)) || '')
      .replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    check('Motivo del rechazo escapado en el HTML', /&lt;b&gt;Referencia&lt;\/b&gt;/.test(htmlPart) && !/<b>Referencia<\/b>/.test(htmlPart));
    const header = await fetch(`${BASE}/api/public/email/cabecera.jpg?v=1`);
    check('Cabecera de los correos pública', header.ok && header.headers.get('content-type') === 'image/jpeg');
    const htmlOf = (m) => (m?.raw.split(/\r\n--[^\r\n]+\r\n/).find(p => /Content-Type: text\/html/.test(p)) || '')
      .replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    const ticketHtml = Buffer.from(htmlOf(mails[2]), 'latin1').toString('utf8');
    check('La confirmación explica cómo presentar la entrada', /Descarga el PDF antes de salir/.test(ticketHtml) && /Apertura de puertas/.test(ticketHtml));
    check('El rechazo enlaza al formulario de la página de compra', htmlOf(mails[6]).includes('https://iluminandocaminos.com/comprar.html#reportar-pago'));
    check('Correos con los dos logos en la cabecera', mails.every(m => htmlOf(m).includes(`${BASE}/api/public/email/cabecera.jpg`)));
    check('Pie con los enlaces de las dos webs', /Sistema de entradas de <a href="https:\/\/hablemosdemarketingmaturin\.com"[^>]*>Hablemos de Marketing<\/a> e <a href="https:\/\/iluminandocaminos\.com"[^>]*>Iluminando Caminos<\/a>\./.test(ticketHtml));
    const statuses = (await api('GET', '/api/admin/overview', { admin: true })).data.emailLogs;
    check('Registro de correos: aceptados por SMTP', statuses.filter(l => l.status === 'SENT_SMTP').length === 8, `${statuses.filter(l => l.status === 'SENT_SMTP').length} SENT_SMTP, ${statuses.filter(l => l.status === 'ERROR').length} ERROR`);
    // --- 6. Mail server left on Mailpit (test mailbox): notices wait, then go out with "Reenviar ahora" ---
    await api('PUT', '/api/admin/settings', { admin: true, json: { smtp_host: 'mailpit', smtp_port: '1025' } });
    const waiting = await api('POST', '/api/public/payment-reports', { form: buyerForm({ buyer_email: 'espera@prueba.test' }) });
    let overview;
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      overview = (await api('GET', '/api/admin/overview', { admin: true })).data;
      if (overview.emailLogs.some(l => l.order_id === waiting.data.order.id)) break;
    }
    // In production Mailpit captures it (SIMULATED_OUTBOX); here no "mailpit" host exists (ERROR). Neither reaches the buyer.
    check('Con Mailpit el aviso no se entrega', overview.settings.smtp_delivery_mode === 'mailpit' && ['SIMULATED_OUTBOX', 'ERROR'].includes(overview.emailLogs.find(l => l.order_id === waiting.data.order.id)?.status));
    check('El panel cuenta los avisos sin entregar', overview.undeliveredEmails === 1, `${overview.undeliveredEmails}`);
    check('No reenvía mientras siga Mailpit', (await api('POST', '/api/admin/mail/retry-pending', { admin: true, json: {} })).status === 409);
    await api('PUT', '/api/admin/settings', { admin: true, json: { smtp_host: '127.0.0.1', smtp_port: String(SMTP_PORT) } });
    const bulk = await api('POST', '/api/admin/mail/retry-pending', { admin: true, json: {} });
    check('«Reenviar ahora» entrega los avisos pendientes', bulk.status === 200 && bulk.data.sent === 1, bulk.data.message);
    check('El aviso reenviado llega al buzón', (await waitMails(9)) === 9 && /^Estamos verificando tu pago$/.test(parseMail(mailFiles()[8]).subject));
    check('Ya no quedan avisos pendientes', (await api('GET', '/api/admin/overview', { admin: true })).data.undeliveredEmails === 0);

    for (const campaignKey of ['REMINDER_2_DAYS', 'REMINDER_1_DAY', 'REMINDER_TODAY', 'EVENT_STARTED']) {
      const before = mailFiles().length;
      const campaign = await api('POST', '/api/admin/notifications/send', { admin: true, json: { campaign_key: campaignKey } });
      await waitMails(before + 2);
      const reminders = mailFiles().slice(before).map(file => htmlOf(parseMail(file)));
      check(`Recordatorio ${campaignKey} con acceso completo y horario de ingreso`,
        campaign.status === 200 && reminders.length === 2 &&
        reminders.every(html => html.includes('acceso a todo el evento') && html.includes('Apertura de puertas')));
    }

    // --- 7. Users: superadmin from the console, admins from the panel ---
    const cli = (args, input) => new Promise(resolve => {
      const child = spawn(process.execPath, ['--no-warnings', 'src/usuarios.js', ...args], { cwd: central, env: { ...process.env, DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      child.on('close', code => resolve({ code, out }));
      child.stdin.end(input || '');
    });
    const signIn = async (username, pass) => {
      const r = await api('POST', '/admin/login', { json: { username, password: pass } });
      return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
    };
    const superPass = crypto.randomBytes(9).toString('hex');
    const adminPass = crypto.randomBytes(9).toString('hex');
    const made = await cli(['crear', 'soporte@prueba.test', 'superadmin'], superPass);
    check('Consola: crear superadministrador', made.code === 0 && /Superadministrador/.test(made.out), made.out.trim());
    check('Consola: no permite un segundo superadministrador', (await cli(['crear', 'otro@prueba.test', 'superadmin'], adminPass)).code === 1);
    check('Consola: no elimina al superadministrador', /no se puede eliminar/.test((await cli(['eliminar', 'soporte@prueba.test'])).out));
    check('La cuenta inicial ya no entra por el login', (await signIn('admin', password)).status === 401);
    check('La sesión de la cuenta inicial se cerró', (await api('GET', '/api/admin/session', { cookie })).status === 401);
    check('Los scripts siguen entrando con HTTP Basic', (await api('GET', '/api/admin/session', { admin: true })).data.role === 'service');
    const sup = await signIn('Soporte@Prueba.test', superPass);
    const supSession = await api('GET', '/api/admin/session', { cookie: sup.cookie });
    check('Login del superadministrador', sup.status === 200 && supSession.data.role === 'superadmin' && supSession.data.named === true);
    const created = [];
    for (const email of ['admin@marketing.test', 'admin@caminos.test']) {
      created.push(await api('POST', '/api/admin/users', { cookie: sup.cookie, json: { email, password: adminPass } }));
    }
    check('Crear los dos administradores desde el panel', created.every(r => r.status === 201 && r.data.user.role === 'admin'));
    check('No repite un correo', (await api('POST', '/api/admin/users', { cookie: sup.cookie, json: { email: 'ADMIN@marketing.test', password: adminPass } })).status === 409);
    const adm = await signIn('admin@marketing.test', adminPass);
    check('Login de un administrador', adm.status === 200);
    check('El administrador ve las operaciones', (await api('GET', '/api/admin/overview', { cookie: adm.cookie })).status === 200);
    const list = await api('GET', '/api/admin/users', { cookie: adm.cookie });
    check('Lista de usuarios', list.data.users.map(u => u.email).join(',') === 'soporte@prueba.test,admin@caminos.test,admin@marketing.test', list.data.users.map(u => u.email).join(','));
    const superId = list.data.users.find(u => u.role === 'superadmin').id;
    check('Nadie elimina al superadministrador', (await api('DELETE', `/api/admin/users/${superId}`, { cookie: adm.cookie })).status === 403);
    check('Nadie cambia su contraseña desde otra cuenta', (await api('PUT', `/api/admin/users/${superId}/password`, { cookie: adm.cookie, json: { password: 'x'.repeat(12) } })).status === 403);
    const other = created[1].data.user.id;
    check('Un administrador no crea usuarios', (await api('POST', '/api/admin/users', { cookie: adm.cookie, json: { email: 'nuevo@prueba.test', password: adminPass } })).status === 403);
    check('Un administrador no elimina a otro', (await api('DELETE', `/api/admin/users/${other}`, { cookie: adm.cookie })).status === 403);
    check('Un administrador no cambia contraseñas ajenas', (await api('PUT', `/api/admin/users/${other}/password`, { cookie: adm.cookie, json: { password: 'x'.repeat(12) } })).status === 403);
    check('Un administrador cambia su propia contraseña', (await api('PUT', '/api/admin/account', { cookie: adm.cookie, json: { current_password: adminPass, new_password: adminPass + '-2' } })).status === 200);
    check('El superadministrador elimina a un administrador', (await api('DELETE', `/api/admin/users/${other}`, { cookie: sup.cookie })).status === 200 && (await signIn('admin@caminos.test', adminPass)).status === 401);
    check('Nadie se elimina a sí mismo', (await api('DELETE', `/api/admin/users/${superId}`, { cookie: sup.cookie })).status === 403);
    const admSession = (await api('GET', '/api/admin/session', { cookie: adm.cookie })).data;
    const supSession2 = (await api('GET', '/api/admin/session', { cookie: sup.cookie })).data;
    check('La sesión dice quién edita la configuración', admSession.canEditSettings === false && admSession.canManageUsers === false && supSession2.canEditSettings === true && supSession2.canManageUsers === true);
    check('Un administrador no cambia la configuración', (await api('PUT', '/api/admin/settings', { cookie: adm.cookie, json: { event_title: 'Cambio no permitido' } })).status === 403);
    check('Un administrador no cambia el correo ni lo prueba', (await api('POST', '/api/admin/mail/test', { cookie: adm.cookie, json: {} })).status === 403);
    check('Un administrador no envía avisos masivos', (await api('POST', '/api/admin/notifications/send', { cookie: adm.cookie, json: { campaign_key: 'REMINDER_2_DAYS' } })).status === 403);
    check('Un administrador sí ve la configuración', (await api('GET', '/api/admin/overview', { cookie: adm.cookie })).data.settings?.smtp_host === '127.0.0.1');
    check('El superadministrador cambia la configuración', (await api('PUT', '/api/admin/settings', { cookie: sup.cookie, json: { event_title: 'Conferencias y concierto benéfico' } })).status === 200);
    check('El panel muestra la sección Usuarios', /id="tab-panel-users"/.test((await api('GET', '/admin/', { cookie: sup.cookie })).data.toString()));

    // --- 8. Sponsors carousel: one list per site, mixed on both or shown separately ---
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const logos = (names, type = 'image/png', data = png) => {
      const form = new FormData();
      for (const name of names) form.append('images', new Blob([data], { type }), name);
      return form;
    };
    const W1 = 'pagina-web-1', W2 = 'pagina-web-2';
    const publicFor = async (site) => (await api('GET', '/api/public/sponsors?site=' + site)).data;
    check('Sin logos, ninguna web los muestra', (await publicFor(W1)).sponsors.length === 0 && (await publicFor(W2)).sponsors.length === 0);
    check('Subir patrocinadores exige sesión', (await api('POST', '/api/admin/sponsors?site=' + W1, { form: logos(['a.png']) })).status === 401);
    check('Exige elegir la página', (await api('POST', '/api/admin/sponsors', { admin: true, form: logos(['a.png']) })).status === 400);
    check('Rechaza archivos que no son imágenes', (await api('POST', '/api/admin/sponsors?site=' + W1, { admin: true, form: logos(['falso.png'], 'image/png', Buffer.from('<svg></svg>')) })).status === 400);
    const up = await api('POST', '/api/admin/sponsors?site=' + W1, { cookie: adm.cookie, form: logos(['Marca_Uno.png', 'Marca Dos.png']) });
    check('Un administrador sube logos a Iluminando Caminos', up.status === 201 && up.data.sites[W1].length === 2 && up.data.sites[W1][0].name === 'Marca Uno', up.data.message);
    const [one, two] = up.data.sites[W1];
    const upTwo = await api('POST', '/api/admin/sponsors?site=' + W2, { admin: true, form: logos(['Aliado HDM.png']) });
    check('Subir un logo a Hablemos de Marketing', upTwo.status === 201 && upTwo.data.sites[W2].length === 1);
    const hdm = upTwo.data.sites[W2][0];
    const media = await fetch(BASE + one.image_url);
    check('Imagen pública del logo', media.ok && media.headers.get('content-type') === 'image/png');
    const linkTo = (id, link_url, name = 'Marca') => api('PUT', '/api/admin/sponsors/' + id, { admin: true, json: { name, link_url } });
    check('Enlace sin https se completa', (await linkTo(one.id, 'instagram.com/marca.uno', 'Marca Uno')).data.sites[W1][0].link_url === 'https://instagram.com/marca.uno');
    check('Enlace de WhatsApp', (await linkTo(two.id, 'wa.me/584121234567', 'Marca Dos')).data.sites[W1][1].link_url === 'https://wa.me/584121234567');
    check('Rechaza enlaces javascript:', (await linkTo(two.id, 'javascript:alert(1)')).status === 400);
    check('Rechaza enlaces con espacios', (await linkTo(two.id, 'mi marca.com')).status === 400);
    check('Rechaza cambios desde otro origen', (await fetch(BASE + '/api/admin/sponsors/' + two.id, { method: 'DELETE', headers: { authorization: basic, origin: 'https://otro.test' } })).status === 403);
    const reordered = await api('PUT', '/api/admin/sponsors/order', { admin: true, json: { site: W1, ids: [two.id, one.id] } });
    check('Reordenar logos', reordered.status === 200 && reordered.data.sites[W1][0].id === two.id);
    const mixed1 = await publicFor(W1);
    const mixed2 = await publicFor(W2);
    check('Mezclados por defecto: las dos webs muestran los tres logos', mixed1.shared === true && mixed1.sponsors.map(s => s.id).join() === [two.id, hdm.id, one.id].join() && mixed2.sponsors.length === 3);
    check('La lista pública trae nombre y enlace', mixed1.sponsors[0].name === 'Marca Dos' && mixed1.sponsors[2].link_url === 'https://instagram.com/marca.uno');
    const separate = await api('PUT', '/api/admin/sponsors/settings', { cookie: adm.cookie, json: { shared: false } });
    check('Desmezclar los patrocinantes', separate.status === 200 && separate.data.shared === false);
    check('Separados: cada web muestra solo los suyos', (await publicFor(W1)).sponsors.length === 2 && (await publicFor(W2)).sponsors.map(s => s.id).join() === String(hdm.id));
    check('Mezclar otra vez', (await api('PUT', '/api/admin/sponsors/settings', { admin: true, json: { shared: true } })).data.shared === true);
    const fill = await api('POST', '/api/admin/sponsors?site=' + W1, { admin: true, form: logos(Array.from({ length: 28 }, (_, i) => 'logo-' + i + '.png')) });
    check('Hasta 30 logos por página', fill.status === 201 && fill.data.sites[W1].length === 30);
    check('No pasa de 30 logos', (await api('POST', '/api/admin/sponsors?site=' + W1, { admin: true, form: logos(['extra.png']) })).status === 409);
    check('El límite es por página', (await api('POST', '/api/admin/sponsors?site=' + W2, { admin: true, form: logos(['otro.png']) })).status === 201);
    const removed = await api('DELETE', '/api/admin/sponsors/' + one.id, { admin: true });
    check('Eliminar un logo borra también su imagen', removed.status === 200 && removed.data.sites[W1].length === 29 && (await fetch(BASE + one.image_url)).status === 404);
    check('Las dos webs cargan el carrusel', /patrocinadores\.js/.test(fs.readFileSync(path.join(root, 'pagina-web-1', 'public', 'index.html'), 'utf8')) && /patrocinadores\.js/.test(fs.readFileSync(path.join(root, 'pagina-web-2', 'public', 'index.html'), 'utf8')));

    check('Log del servidor sin errores inesperados', !/Error (approving|rejecting|submitting)|Unhandled|TypeError/.test(serverLog));
  } catch (err) {
    check('Prueba completa sin excepciones', false, err.stack);
  } finally {
    server.kill();
    sink.kill();
    if (fs.existsSync(ticketsDir)) for (const f of fs.readdirSync(ticketsDir)) if (!ticketsBefore.has(f)) fs.rmSync(path.join(ticketsDir, f));
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas`);
    if (failed.length) console.log(`
Registro del sistema central:
${serverLog}`);
    fs.rmSync(work, { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
  }
})();
