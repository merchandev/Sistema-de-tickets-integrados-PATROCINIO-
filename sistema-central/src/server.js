require('dotenv').config();
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');

const {
  db,
  getAllSettings,
  getPublicConfig,
  updateSettings,
  releaseExpiredLocks,
  lockTicketAtomic,
  unlockTicketAtomic,
  submitOrderAtomic,
  submitPaymentReport,
  approveOrderAtomic,
  rejectOrderAtomic,
  getAllTicketsPublic
} = require('./db');
const { scrapeBcvRate } = require('./bcvScraper');
const { generateTicketPdf } = require('./pdfGenerator');
const { parsePaymentForm, parseTicketNumber } = require('./paymentForm');
const {
  sendPaymentSubmittedEmail,
  sendPaymentApprovedEmail,
  sendTicketEmail,
  sendPaymentRejectedEmail,
  sendEventCampaignNotification,
  testMailConnections
} = require('./mailer');

const PORT = parseInt(process.env.PORT || '4000', 10);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

const app = express();
const crypto = require('node:crypto');
const proxyKey = process.env.WEB_PROXY_KEY_FILE ? fs.readFileSync(process.env.WEB_PROXY_KEY_FILE, 'utf8').trim() : '';
function resolveSalesSource(req) {
  const source = req.headers['x-sales-source'];
  const supplied = Buffer.from(req.headers['x-sales-key'] || '');
  const expected = Buffer.from(proxyKey);
  if (proxyKey && supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected) && ['pagina-web-1', 'pagina-web-2'].includes(source)) return source;
  if (!proxyKey && ['pagina-web-1', 'pagina-web-2'].includes(req.body.source_web)) return req.body.source_web;
  return null;
}
if (!process.env.ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD es obligatorio');
function adminAuth(req, res, next) {
  const expected = Buffer.from((process.env.ADMIN_USER || 'admin') + ':' + process.env.ADMIN_PASSWORD);
  const supplied = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64');
  if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Administracion de entradas"');
  return res.status(401).json({ok:false, message:'Autenticacion requerida'});
}
app.get('/health', (_req, res) => { db.prepare('SELECT 1').get(); res.json({ok:true}); });
app.use(['/admin', '/api/admin', '/storage'], adminAuth);
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  }
});

// Ensure storage directories exist
const uploadsDir = path.join(__dirname, '..', 'storage', 'uploads');
const ticketsDir = path.join(__dirname, '..', 'storage', 'tickets');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(ticketsDir, { recursive: true });

// Configure Multer for payment screenshot uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '.png') || '.png';
    const safeTicket = String(req.body.ticket_number || '000').replace(/[^0-9]/g, '');
    cb(null, `pago-ticket-${safeTicket}-${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype) && /\.(png|jpe?g|webp)$/i.test(file.originalname)),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB max
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
require('./blog').registerBlogRoutes(app, {db, storageDir:process.env.BLOG_STORAGE_DIR || path.join(__dirname, '..', 'storage')});

// Static assets
app.use('/storage/uploads', express.static(uploadsDir));
app.use('/storage/tickets', express.static(ticketsDir));
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));

// Root redirect to /admin
app.get('/', (_req, res) => {
  res.redirect('/admin');
});

// Direct QR verification link handler -> redirects to Admin QR scanner/verifier with token preloaded
app.get('/verify/:token', (req, res) => {
  const token = encodeURIComponent(req.params.token);
  res.redirect(`/admin/?verifyToken=${token}#qr-scanner`);
});

// Helper to broadcast full synchronized state to all connected pages & dashboard
function broadcastTicketsUpdate(extraEvent = null) {
  for (const socket of io.sockets.sockets.values()) socket.emit('tickets:updated', getAllTicketsPublic(socket.handshake.query?.sessionId));
  if (extraEvent) {
    io.emit(extraEvent.name, { changed: true });
  }
}

function broadcastConfigUpdate() {
  const config = getPublicConfig();
  io.emit('config:updated', config);
}

// ============================================================================
// PUBLIC API (Used by Pagina Web 1 & Pagina Web 2)
// ============================================================================

function requireSalesOpen(_req, res, next) {
  if (process.env.SALES_ENABLED === 'false') return res.status(503).json({ok:false, code:'SALES_NOT_OPEN', message:'La venta de entradas estara disponible proximamente. Aun no debes realizar pagos.'});
  return next();
}

app.get('/api/public/state', (req, res) => {
  const config = getPublicConfig();
  const ticketState = getAllTicketsPublic(req.headers['x-session-id']);
  res.json({
    ok: true,
    config,
    ...ticketState
  });
});

app.get('/api/public/bcv', async (_req, res) => {
  const result = await scrapeBcvRate();
  const config = getPublicConfig();
  broadcastConfigUpdate();
  res.json({
    ok: result.success,
    bcv: result,
    config
  });
});

/**
 * Atomic 3-minute seat lock endpoint.
 * Priority is strictly given to the first request that arrives.
 */
app.post('/api/public/tickets/lock', requireSalesOpen, async (req, res) => {
  try {
    const { ticket_number, session_id, source_web } = req.body;
    if (!/^\d{1,3}$/.test(String(ticket_number)) || Number(ticket_number) < 1 || Number(ticket_number) > 250 || typeof session_id !== 'string' || session_id.length < 8 || session_id.length > 254) {
      return res.status(400).json({
        ok: false,
        message: 'Faltan parámetros requeridos (ticket_number, session_id).'
      });
    }

    const paddedNumber = String(ticket_number).padStart(3, '0');
    const source = resolveSalesSource(req);
    if (!source) return res.status(403).json({ok:false, code:'INVALID_SOURCE', message:'Selecciona la entrada desde una de las paginas de venta.'});
    await scrapeBcvRate({maxAgeMs:5 * 60 * 1000});
    const current = getPublicConfig();
    if (current.bcv_mode !== 'manual' && (!current.bcv_is_official || Date.now() - Date.parse(current.bcv_last_updated) > 24*60*60*1000)) return res.status(503).json({ok:false, code:'BCV_UNAVAILABLE', message:'No hay una tasa oficial BCV reciente confirmada. Intenta nuevamente mas tarde.'});

    const result = lockTicketAtomic(paddedNumber, session_id, source);
    if (!result.success) {
      return res.status(409).json({
        ok: false,
        code: result.code,
        remainingSeconds: result.remainingSeconds || 0,
        lockedBySource: result.lockedBySource || null,
        message: result.message
      });
    }

    broadcastTicketsUpdate({
      name: 'ticket:locked',
      payload: {
        ticket_number: paddedNumber,
        locked_by_source: source,
        locked_until: result.ticket.locked_until
      }
    });

    const config = getPublicConfig();
    return res.json({
      ok: true,
      message: `Entrada #${paddedNumber} reservada temporalmente por ${Math.round(config.lock_duration_seconds / 60)} minutos.`,
      ticket: result.ticket,
      serverTime: result.serverTime,
      lockDurationSeconds: config.lock_duration_seconds,
      pricing: {
        amount_usd: result.ticket.quoted_usd,
        bcv_rate: result.ticket.quoted_rate,
        amount_ves: result.ticket.quoted_ves
      }
    });
  } catch (err) {
    console.error('Error locking ticket:', err);
    return res.status(500).json({ ok: false, message: 'Error interno al bloquear la entrada.' });
  }
});

/**
 * Voluntary unlock endpoint (if buyer explicitly clicks "Cambiar de entrada / Cancelar")
 */
app.post('/api/public/tickets/unlock', (req, res) => {
  try {
    const { ticket_number, session_id } = req.body;
    if (!ticket_number || !session_id) {
      return res.status(400).json({ ok: false, message: 'Faltan datos.' });
    }
    const paddedNumber = String(ticket_number).padStart(3, '0');
    const result = unlockTicketAtomic(paddedNumber, session_id);
    if (result.released) {
      broadcastTicketsUpdate();
    }
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// Emails that must not delay the HTTP response; failures are already recorded in email_logs.
function sendInBackground(promise) {
  promise.then((result) => {
    if (result.status === 'ERROR') console.error('[Mail] No se pudo enviar el correo:', result.errorMessage);
  }).catch((err) => console.error('[Mail] Error inesperado al enviar el correo:', err.message));
}

// Optional proof of payment: kept only when the buyer attaches it.
function saveScreenshot(req, label) {
  if (req.file) return `/storage/uploads/${req.file.filename}`;
  if (!req.body.screenshot_base64) return '';
  const filename = `pago-${label}-${Date.now()}.png`;
  fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(req.body.screenshot_base64.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
  return `/storage/uploads/${filename}`;
}
const validScreenshot = (req) => !req.body.screenshot_base64 || /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(req.body.screenshot_base64);

/**
 * Payment form of the checkout popup: buyer data + Pago Móvil reference for the ticket locked by this session.
 */
app.post('/api/public/orders', requireSalesOpen, upload.single('screenshot'), async (req, res) => {
  try {
    if (!resolveSalesSource(req)) return res.status(403).json({ok:false, code:'INVALID_SOURCE', message:'Reporta el pago desde una de las paginas de venta.'});
    const ticketNumber = parseTicketNumber(req.body.ticket_number);
    const sessionId = req.body.session_id;
    if (!ticketNumber || typeof sessionId !== 'string' || sessionId.length < 8 || sessionId.length > 254) {
      return res.status(400).json({ ok: false, message: 'Selecciona una entrada antes de reportar el pago.' });
    }
    const form = parsePaymentForm(req.body);
    if (!form.ok) return res.status(400).json({ ok: false, field: form.field, message: form.message });
    if (!validScreenshot(req)) return res.status(400).json({ ok: false, field: 'screenshot', message: 'Captura invalida' });

    const config = getPublicConfig();
    const submitResult = submitOrderAtomic({
      ticket_number: ticketNumber,
      session_id: sessionId,
      ...form.data,
      screenshot_path: saveScreenshot(req, `ticket-${ticketNumber}`),
      amount_usd: config.ticket_price_usd,
      bcv_rate: config.bcv_rate,
      amount_ves: config.ticket_price_ves
    });

    if (!submitResult.success) {
      return res.status(409).json({
        ok: false,
        code: submitResult.code,
        message: submitResult.message
      });
    }

    // Real-time update for both pages and the dashboard; the "Pago en verificación" email goes out in
    // the background so the buyer gets the confirmation without waiting for the mail server.
    broadcastTicketsUpdate({
      name: 'admin:order_created',
      payload: submitResult.order
    });
    sendInBackground(sendPaymentSubmittedEmail(submitResult.order));

    const { id, buyer_email: email, status } = submitResult.order;
    return res.status(201).json({
      ok: true,
      message: `Recibimos el pago de tu entrada #${ticketNumber}. Te enviamos un correo a ${email}: la verificación puede tardar hasta 24 horas y, al aprobarse, recibirás tu entrada en PDF.`,
      order: { id, ticket_number: ticketNumber, buyer_email: email, status }
    });
  } catch (err) {
    console.error('Error submitting order:', err);
    return res.status(500).json({ ok: false, message: 'Error interno al procesar la compra.' });
  }
});

/**
 * Standalone payment report ("Reporte de pago"), for buyers who paid but could not finish the popup.
 * No ticket is held: the administrator assigns an available one when approving it.
 */
app.post('/api/public/payment-reports', requireSalesOpen, upload.single('screenshot'), async (req, res) => {
  try {
    const source = resolveSalesSource(req);
    if (!source) return res.status(403).json({ok:false, code:'INVALID_SOURCE', message:'Reporta el pago desde una de las paginas de venta.'});
    const form = parsePaymentForm(req.body);
    if (!form.ok) return res.status(400).json({ ok: false, field: form.field, message: form.message });
    const requested = req.body.requested_ticket ? parseTicketNumber(req.body.requested_ticket) : null;
    if (req.body.requested_ticket && !requested) return res.status(400).json({ ok: false, field: 'requested_ticket', message: 'El número de entrada va del 001 al 250.' });
    if (!validScreenshot(req)) return res.status(400).json({ ok: false, field: 'screenshot', message: 'Captura invalida' });

    const config = getPublicConfig();
    const sessionId = typeof req.body.session_id === 'string' && req.body.session_id.length <= 254 ? req.body.session_id : '';
    const order = submitPaymentReport({
      source_web: source,
      session_id: sessionId || 'reporte',
      ...form.data,
      screenshot_path: saveScreenshot(req, 'reporte'),
      amount_usd: config.ticket_price_usd,
      bcv_rate: config.bcv_rate,
      amount_ves: config.ticket_price_ves,
      requested_ticket: requested,
      buyer_comment: typeof req.body.buyer_comment === 'string' ? req.body.buyer_comment.trim().slice(0, 500) : ''
    });

    io.emit('admin:order_created', { changed: true });
    sendInBackground(sendPaymentSubmittedEmail(order));

    return res.status(201).json({
      ok: true,
      message: `Recibimos tu reporte de pago. Te enviamos un correo a ${order.buyer_email}: la verificación puede tardar hasta 24 horas y, al aprobarse, recibirás tu entrada en PDF.`,
      order: { id: order.id, status: order.status }
    });
  } catch (err) {
    console.error('Error submitting payment report:', err);
    return res.status(500).json({ ok: false, message: 'Error interno al registrar el reporte de pago.' });
  }
});

// ============================================================================
// ADMIN DASHBOARD API
// ============================================================================

// Settings as the dashboard sees them: stored mail passwords are never sent back, only whether one exists.
function adminSettings() {
  const settings = getAllSettings();
  delete settings.secret_hmac_key;
  for (const key of ['smtp_pass', 'imap_pass']) {
    settings[`${key}_set`] = Boolean(settings[key]);
    delete settings[key];
  }
  return settings;
}

app.get('/api/admin/overview', (_req, res) => {
  releaseExpiredLocks();
  const ticketsState = getAllTicketsPublic();
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
  const emailLogs = db.prepare('SELECT * FROM email_logs ORDER BY id DESC LIMIT 100').all();
  const campaigns = db.prepare('SELECT * FROM notification_campaigns ORDER BY id DESC LIMIT 50').all();
  const rawSettings = adminSettings();
  const publicConfig = getPublicConfig();

  const counts = {
    total: 250,
    available: 0,
    locked: 0,
    pending: 0,
    sold: 0,
    sold_web_1: 0,
    sold_web_2: 0,
    revenue_usd: 0,
    revenue_ves: 0
  };
  const salesBySource = Object.fromEntries(['pagina-web-1', 'pagina-web-2', 'unknown'].map(source => [source, {sold:0, pending:0, rejected:0, revenue_usd:0, revenue_ves:0}]));

  for (const t of ticketsState.tickets) {
    if (t.status === 'AVAILABLE') counts.available++;
    else if (t.status === 'LOCKED') counts.locked++;
    else if (t.status === 'PENDING') counts.pending++;
    else if (t.status === 'SOLD') counts.sold++;
  }

  for (const o of orders) {
    const summary = salesBySource[o.source_web] || salesBySource.unknown;
    if (o.status === 'PENDING') summary.pending++;
    if (o.status === 'REJECTED') summary.rejected++;
    if (o.status === 'APPROVED') {
      summary.sold++;
      summary.revenue_usd += Number(o.amount_usd || 0);
      summary.revenue_ves += Number(o.amount_ves || 0);
      counts.revenue_usd += Number(o.amount_usd || 0);
      counts.revenue_ves += Number(o.amount_ves || 0);
      if (o.source_web === 'pagina-web-1') counts.sold_web_1++;
      if (o.source_web === 'pagina-web-2') counts.sold_web_2++;
    }
  }

  res.json({
    ok: true,
    counts,
    salesBySource,
    publicConfig,
    settings: rawSettings,
    tickets: ticketsState.tickets,
    orders,
    emailLogs,
    campaigns
  });
});

/**
 * Approve payment -> Marks ticket SOLD, generates unique Token & PDF with QR, then emails the buyer
 * "Pago aceptado" and a second message with the ticket PDF. Payment reports need `ticket_number`.
 */
app.post('/api/admin/orders/:id/approve', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { admin_notes, ticket_number } = req.body || {};
    const assignTicket = ticket_number ? parseTicketNumber(ticket_number) : null;
    if (ticket_number && !assignTicket) return res.status(400).json({ ok: false, message: 'El número de entrada va del 001 al 250.' });

    const result = approveOrderAtomic(orderId, admin_notes, assignTicket);
    if (!result.success) {
      return res.status(400).json({ ok: false, message: result.message });
    }

    const config = getPublicConfig();
    const { pdfFullPath, pdfRelativeUrl, qrDataUrl, verificationUrl } = await generateTicketPdf(
      result.order,
      config,
      PUBLIC_BASE_URL
    );

    // Save PDF path in order record
    db.prepare('UPDATE orders SET pdf_path = ? WHERE id = ?').run(pdfRelativeUrl, orderId);
    const finalOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

    // "Pago aceptado" first, then the ticket itself with the PDF attached
    const approvedEmail = await sendPaymentApprovedEmail(finalOrder);
    const emailResult = await sendTicketEmail(finalOrder, pdfFullPath, pdfRelativeUrl);

    broadcastTicketsUpdate({
      name: 'admin:order_updated',
      payload: finalOrder
    });

    return res.json({
      ok: true,
      message: `Pago aprobado y entrada #${finalOrder.ticket_number} generada. Correo de pago aceptado: ${approvedEmail.status}. Correo con la entrada PDF: ${emailResult.status}.`,
      order: finalOrder,
      pdfUrl: pdfRelativeUrl,
      qrDataUrl,
      verificationUrl,
      emailResult
    });
  } catch (err) {
    console.error('Error approving order:', err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Reject payment -> Releases ticket back to AVAILABLE and notifies buyer
 */
app.post('/api/admin/orders/:id/reject', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { reason } = req.body || {};

    const result = rejectOrderAtomic(orderId, reason);
    if (!result.success) {
      return res.status(400).json({ ok: false, message: result.message });
    }

    await sendPaymentRejectedEmail(result.order, reason);

    broadcastTicketsUpdate({
      name: 'admin:order_updated',
      payload: result.order
    });

    return res.json({
      ok: true,
      message: result.order.ticket_number ? `Pago rechazado. La entrada #${result.order.ticket_number} vuelve a estar disponible.` : 'Reporte de pago rechazado. Se notificó al comprador.',
      order: result.order
    });
  } catch (err) {
    console.error('Error rejecting order:', err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Verify QR Code / Token authenticity in Admin Dashboard
 */
app.get('/api/admin/verify-qr/:rawToken', (req, res) => {
  try {
    let token = decodeURIComponent(req.params.rawToken || '').trim();
    // If scanned QR is a full URL like http://.../verify/TK-001-..., extract the token part
    if (token.includes('/verify/')) {
      token = token.split('/verify/').pop().split('?')[0].split('#')[0].trim();
    } else if (token.includes('verifyToken=')) {
      token = new URLSearchParams(token.split('?')[1]).get('verifyToken') || token;
    }

    const order = db.prepare('SELECT * FROM orders WHERE verification_token = ?').get(token);
    if (!order) {
      return res.status(404).json({
        ok: false,
        valid: false,
        token,
        message: '❌ CÓDIGO QR INVÁLIDO O FALSIFICADO: Este token no existe ni pertenece al sistema de administración de entradas.'
      });
    }

    if (order.status !== 'APPROVED') {
      return res.status(400).json({
        ok: false,
        valid: false,
        token,
        order,
        message: `⚠️ ENTRADA NO ACTIVA: La orden asociada a este token tiene estado "${order.status}".`
      });
    }

    return res.json({
      ok: true,
      valid: true,
      token,
      message: `✅ ENTRADA AUTÉNTICA Y VERIFICADA (#${order.ticket_number}) - Titular: ${order.buyer_name} (C.I. ${order.buyer_cedula})`,
      order
    });
  } catch (err) {
    return res.status(500).json({ ok: false, valid: false, message: err.message });
  }
});

/**
 * Check-in attendee at the door (Parte 1: Conferencias 4PM-7PM / Parte 2: Concierto 7PM+)
 */
app.post('/api/admin/verify-qr/:rawToken/checkin', (req, res) => {
  try {
    let token = decodeURIComponent(req.params.rawToken || '').trim();
    if (token.includes('/verify/')) {
      token = token.split('/verify/').pop().split('?')[0].split('#')[0].trim();
    }

    const { stage } = req.body;
    if (!['conference', 'concert'].includes(stage)) return res.status(400).json({ok:false, message:'Etapa invalida'}); // 'conference' or 'concert'
    const order = db.prepare('SELECT * FROM orders WHERE verification_token = ? AND status = \'APPROVED\'').get(token);
    if (!order) {
      return res.status(404).json({ ok: false, message: 'Token QR no válido.' });
    }

    if (stage === 'concert') {
      if (order.checked_in_concert) {
        return res.status(409).json({
          ok: false,
          alreadyCheckedIn: true,
          message: `⚠️ Atención: Esta entrada (#${order.ticket_number}) YA fue ingresada al Concierto a las ${order.checked_in_concert_at}.`,
          order
        });
      }
      db.prepare(`
        UPDATE orders SET checked_in_concert = 1, checked_in_concert_at = datetime('now') WHERE id = ?
      `).run(order.id);
    } else {
      if (order.checked_in_conference) {
        return res.status(409).json({
          ok: false,
          alreadyCheckedIn: true,
          message: `⚠️ Atención: Esta entrada (#${order.ticket_number}) YA fue ingresada a las Conferencias a las ${order.checked_in_conference_at}.`,
          order
        });
      }
      db.prepare(`
        UPDATE orders SET checked_in_conference = 1, checked_in_conference_at = datetime('now') WHERE id = ?
      `).run(order.id);
    }

    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    io.emit('admin:order_updated', { changed: true });

    return res.json({
      ok: true,
      message: `✅ Ingreso registrado exitosamente para ${updated.buyer_name} (Entrada #${updated.ticket_number}).`,
      order: updated
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Update Event Settings, Terms, Conditions, Schedule, BCV & SMTP
 */
app.put('/api/admin/settings', (req, res) => {
  try {
    const updates = {...(req.body || {})};
    // An empty password field means "keep the stored one" (the dashboard never receives it).
    for (const key of ['smtp_pass', 'imap_pass']) if (key in updates && !updates[key]) delete updates[key];
    const allowed = new Set(Object.keys(getAllSettings()).filter(k => k !== 'secret_hmac_key' && (!k.startsWith('bcv_') || ['bcv_mode', 'bcv_manual_rate'].includes(k))));
    if (Object.keys(updates).some(k => !allowed.has(k))) return res.status(400).json({ok:false, message:'Parametro no permitido'});
    for (const key of ['ticket_price_usd', 'bcv_manual_rate', 'lock_duration_seconds', 'smtp_port', 'imap_port']) if (key in updates && (!Number.isFinite(Number(updates[key])) || Number(updates[key]) <= 0)) return res.status(400).json({ok:false, message:'Valor numerico invalido'});
    updateSettings(updates);
    broadcastConfigUpdate();
    return res.json({
      ok: true,
      message: 'Configuración actualizada y sincronizada en tiempo real con Página Web 1 y Página Web 2.',
      publicConfig: getPublicConfig(),
      settings: adminSettings()
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Checks the saved SMTP and IMAP accounts and, with `to`, sends a test message.
 */
app.post('/api/admin/mail/test', async (req, res) => {
  try {
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ ok: false, message: 'Correo de prueba invalido' });
    const result = await testMailConnections(to);
    return res.json({ ok: result.smtp.ok && result.imap.ok !== false && (!result.sent || result.sent.ok), ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Force refresh BCV rate
 */
app.post('/api/admin/bcv/refresh', async (_req, res) => {
  try {
    const result = await scrapeBcvRate();
    broadcastConfigUpdate();
    return res.json({
      ok: result.success,
      message: result.success ? `Tasa BCV actualizada: Bs. ${result.rate} (${result.source})` : `No se pudo consultar BCV: ${result.error}. Se conserva la ultima consulta oficial.`,
      bcv: result,
      publicConfig: getPublicConfig()
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Send Mass Event Notification ("Faltan 2 días", "Falta 1 día", "Falta hoy", "Ya comenzamos el evento")
 */
app.post('/api/admin/notifications/send', async (req, res) => {
  try {
    const { campaign_key } = req.body;
    const result = await sendEventCampaignNotification(campaign_key, 'MANUAL_ADMIN');
    return res.json({
      ok: true,
      message: `Notificación "${campaign_key}" enviada a ${result.recipientsCount} comprador(es) verificado(s).`,
      result
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// ============================================================================
// REAL-TIME SOCKET.IO & BACKGROUND TIMERS
// ============================================================================

io.on('connection', (socket) => {
  const clientSource = socket.handshake.query?.source || 'client';
  socket.emit('init:state', {
    config: getPublicConfig(),
    ...getAllTicketsPublic(socket.handshake.query?.sessionId)
  });

  socket.on('disconnect', () => {
    // Note: Per user requirement, if a session closes without completing purchase,
    // the ticket stays blocked for the remaining of the 3-minute period and then releases automatically!
  });
});

// 1-second precision timer to release expired 3-minute locks and notify all clients immediately
setInterval(() => {
  const expired = releaseExpiredLocks();
  if (expired.length > 0) {
    broadcastTicketsUpdate({
      name: 'tickets:expired',
      payload: expired
    });
  }
}, 1000);

// Automatic date-based notification checker (runs every 60s)
setInterval(async () => {
  try {
    const cfg = getPublicConfig();
    if (!cfg.event_date) return;

    for (const targetCampaign of require('./notificationSchedule').dueCampaigns(cfg)) {

      const alreadySent = db.prepare(`
        SELECT id FROM notification_campaigns
        WHERE campaign_key = ? AND date(created_at, '-4 hours') = date('now', '-4 hours')
      `).get(targetCampaign);

      if (!alreadySent) {
        const approvedCount = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'APPROVED'").get().c;
        if (approvedCount > 0) {
          await sendEventCampaignNotification(targetCampaign, 'AUTO_CRON');
        }
      }
    }
  } catch (err) {
    console.error('Auto notification check error:', err.message);
  }
}, 60 * 1000);

// Initial BCV scrape on startup + periodic refresh every 15 minutes
scrapeBcvRate().then((r) => {
  console.log(`[BCV Scraper] Tasa inicial cargada: Bs. ${r.rate} (${r.source})`);
  broadcastConfigUpdate();
});
setInterval(() => {
  scrapeBcvRate().then(() => broadcastConfigUpdate());
}, 15 * 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`================================================================`);
  console.log(`🚀 SISTEMA CENTRAL DE ENTRADAS ACTIVO EN PUERTO ${PORT}`);
  console.log(`📊 Dashboard Admin: http://localhost:${PORT}/admin`);
  console.log(`🔌 API & Socket.IO: http://localhost:${PORT}`);
  console.log(`================================================================`);
});
