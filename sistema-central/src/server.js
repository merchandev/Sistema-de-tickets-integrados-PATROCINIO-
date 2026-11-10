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
  getReservationState,
  getAllTicketsForAdmin
} = require('./db');
const { scrapeBcvRate } = require('./bcvScraper');
const { generateTicketPdf, generateDemoTicketPdf } = require('./pdfGenerator');
const { parsePaymentForm, parseTicketNumber } = require('./paymentForm');
const { resetTickets } = require('./ticketReset');
const {
  sendPaymentSubmittedEmail,
  sendTicketEmail,
  sendPaymentRejectedEmail,
  sendEventCampaignNotification,
  testMailConnections,
  mailDeliveryMode,
  retryOrderEmail,
  undeliveredOrderEmails,
  retryUndeliveredOrderEmails
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
const adminAuth = require('./adminAuth');
// Traefik terminates HTTPS: trust its X-Forwarded-* headers for the client IP and the Secure cookie.
app.set('trust proxy', 1);
app.get('/health', (_req, res) => { db.prepare('SELECT 1').get(); res.json({ok:true}); });

// Sign-in page of the dashboard shared by both sites (outside the protected area)
const loginBody = [express.json({ limit: '10kb' }), express.urlencoded({ extended: false, limit: '10kb' })];
app.get(['/admin/login', '/admin/login/'], (req, res) => {
  if (adminAuth.sessionFrom(req)) return res.redirect(adminAuth.safeNext(req.query.next));
  res.set('Cache-Control', 'no-store');
  return res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});
app.post('/admin/login', loginBody, adminAuth.login);
app.post('/admin/logout', adminAuth.logout);
app.get('/admin/console-credit.js', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'console-credit.js'));
});
app.get('/admin/brands/espressivo-venezuela.png', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'brands', 'espressivo-venezuela.png'));
});
app.use(['/admin', '/api/admin', '/storage'], adminAuth.requireAdmin);
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  }
});

// Ensure storage directories exist
const storageDir = path.join(__dirname, '..', 'storage');
const uploadsDir = path.join(storageDir, 'uploads');
const ticketsDir = path.join(storageDir, 'tickets');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(ticketsDir, { recursive: true });

let activeTicketOperations = 0;

async function runTicketOperation(work) {
  activeTicketOperations++;
  try {
    return await work();
  } finally {
    activeTicketOperations--;
  }
}

function ticketRoute(handler, before) {
  return (req, res, next) => runTicketOperation(async () => {
    if (before) {
      await new Promise((resolve, reject) => before(req, res, err => err ? reject(err) : resolve()));
    }
    return handler(req, res);
  }).catch(next);
}

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
require('./sponsors').registerSponsorRoutes(app, {db, storageDir:process.env.BLOG_STORAGE_DIR || path.join(__dirname, '..', 'storage')});

// Static assets
app.use('/storage/uploads', express.static(uploadsDir));
app.use('/storage/tickets', express.static(ticketsDir));
const pdfJsDir = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist');
app.get('/admin/pdfjs/:file(pdf.min.mjs|pdf.worker.min.mjs)', (req, res) => {
  res.sendFile(path.join(pdfJsDir, 'legacy', 'build', req.params.file));
});
app.use('/admin/pdfjs/fonts', express.static(path.join(pdfJsDir, 'standard_fonts')));
app.get('/admin/blog-turndown.js', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'node_modules', 'turndown', 'dist', 'turndown.js'));
});
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

// Only the dashboard receives inventory invalidations. Buyers receive updates to their own reservation.
function broadcastTicketsUpdate(extraEvent = null) {
  io.to('admins').emit('tickets:updated', { changed: true });
  if (extraEvent?.name.startsWith('admin:')) io.to('admins').emit(extraEvent.name, { changed: true });
  for (const socket of io.sockets.sockets.values()) {
    if (!socket.handshake.query?.sessionId) continue;
    const state = getReservationState(socket.handshake.query.sessionId);
    const key = state.reservation ? `${state.reservation.ticket_number}:${state.reservation.locked_until}` : null;
    if (socket.data.reservationKey !== key) {
      socket.data.reservationKey = key;
      socket.emit('reservation:updated', state);
    }
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
  if (process.env.SALES_ENABLED === 'false') return res.status(503).json({ok:false, code:'SALES_NOT_OPEN', message:'La venta de entradas estará disponible próximamente. Aún no debes realizar pagos.'});
  return next();
}

// Header image of the buyer emails; public so mail clients can load it from either site
app.get('/api/public/email/cabecera.jpg', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'email', 'cabecera.jpg'), { maxAge: '30d' });
});

app.get('/api/public/state', (req, res) => {
  const config = getPublicConfig();
  const ticketState = getReservationState(req.headers['x-session-id']);
  res.set('Cache-Control', 'no-store');
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
app.post('/api/public/tickets/lock', requireSalesOpen, ticketRoute(async (req, res) => {
  try {
    const { session_id } = req.body;
    if (typeof session_id !== 'string' || session_id.length < 8 || session_id.length > 254) {
      return res.status(400).json({
        ok: false,
        message: 'No encontramos tu sesión. Recarga la página e inténtalo de nuevo.'
      });
    }

    const source = resolveSalesSource(req);
    if (!source) return res.status(403).json({ok:false, code:'INVALID_SOURCE', message:'Solicita tu entrada desde una de las páginas de venta.'});
    await scrapeBcvRate({maxAgeMs:5 * 60 * 1000});
    const current = getPublicConfig();
    if (current.bcv_mode !== 'manual' && (!current.bcv_is_official || Date.now() - Date.parse(current.bcv_last_updated) > 24*60*60*1000)) return res.status(503).json({ok:false, code:'BCV_UNAVAILABLE', message:'No hay una tasa oficial BCV reciente confirmada. Intenta nuevamente mas tarde.'});

    const result = lockTicketAtomic(null, session_id, source);
    if (!result.success) {
      return res.status(409).json({
        ok: false,
        code: result.code,
        message: result.message
      });
    }

    broadcastTicketsUpdate();

    const config = getPublicConfig();
    return res.json({
      ok: true,
      message: `Entrada #${result.ticket.ticket_number} reservada temporalmente por ${Math.round(config.lock_duration_seconds / 60)} minutos.`,
      ticket: { ticket_number: result.ticket.ticket_number, locked_until: result.ticket.locked_until },
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
}));

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
function sendInBackground(send) {
  runTicketOperation(send).then((result) => {
    if (result.status === 'ERROR') console.error('[Mail] No se pudo enviar el correo:', result.errorMessage);
  }).catch((err) => console.error('[Mail] Error inesperado al enviar el correo:', err.message));
}

// Proof of payment, required in both forms (an image file, or a PNG data URL from older clients).
function saveScreenshot(req, label) {
  if (req.file) return `/storage/uploads/${req.file.filename}`;
  if (!req.body.screenshot_base64) return '';
  const filename = `pago-${label}-${Date.now()}.png`;
  fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(req.body.screenshot_base64.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
  return `/storage/uploads/${filename}`;
}
const validScreenshot = (req) => !req.body.screenshot_base64 || /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(req.body.screenshot_base64);
const hasScreenshot = (req) => Boolean(req.file || req.body.screenshot_base64);
const MISSING_SCREENSHOT = { ok: false, field: 'screenshot', message: 'Adjunta la captura del pago (imagen PNG, JPG o WebP de hasta 10 MB).' };

/**
 * Payment form of the checkout popup: buyer data + Pago Móvil reference for the ticket locked by this session.
 */
app.post('/api/public/orders', requireSalesOpen, ticketRoute(async (req, res) => {
  try {
    if (!resolveSalesSource(req)) return res.status(403).json({ok:false, code:'INVALID_SOURCE', message:'Reporta el pago desde una de las páginas de venta.'});
    const ticketNumber = parseTicketNumber(req.body.ticket_number);
    const sessionId = req.body.session_id;
    if (!ticketNumber || typeof sessionId !== 'string' || sessionId.length < 8 || sessionId.length > 254) {
      return res.status(400).json({ ok: false, message: 'Solicita que te asignemos una entrada antes de reportar el pago.' });
    }
    const form = parsePaymentForm(req.body);
    if (!form.ok) return res.status(400).json({ ok: false, field: form.field, message: form.message });
    if (!validScreenshot(req)) return res.status(400).json({ ok: false, field: 'screenshot', message: 'La captura no es una imagen válida.' });
    if (!hasScreenshot(req)) return res.status(400).json(MISSING_SCREENSHOT);

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
    sendInBackground(() => sendPaymentSubmittedEmail(submitResult.order));

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
}, upload.single('screenshot')));

/**
 * Standalone payment report ("Reporte de pago"), for buyers who paid but could not finish the popup.
 * No ticket is held: the administrator assigns an available one when approving it.
 */
app.post('/api/public/payment-reports', requireSalesOpen, ticketRoute(async (req, res) => {
  try {
    const source = resolveSalesSource(req);
    if (!source) return res.status(403).json({ok:false, code:'INVALID_SOURCE', message:'Reporta el pago desde una de las páginas de venta.'});
    const form = parsePaymentForm(req.body);
    if (!form.ok) return res.status(400).json({ ok: false, field: form.field, message: form.message });
    const requested = parseTicketNumber(req.body.requested_ticket);
    if (!requested) return res.status(400).json({ ok: false, field: 'requested_ticket', message: 'Indica el número de entrada que se te asignó.' });
    const comment = typeof req.body.buyer_comment === 'string' ? req.body.buyer_comment.trim().slice(0, 500) : '';
    if (comment.length < 3) return res.status(400).json({ ok: false, field: 'buyer_comment', message: 'Cuéntanos brevemente qué pasó con tu pago.' });
    if (!validScreenshot(req)) return res.status(400).json({ ok: false, field: 'screenshot', message: 'La captura no es una imagen válida.' });
    if (!hasScreenshot(req)) return res.status(400).json(MISSING_SCREENSHOT);

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
      buyer_comment: comment
    });

    io.to('admins').emit('admin:order_created', { changed: true });
    sendInBackground(() => sendPaymentSubmittedEmail(order));

    return res.status(201).json({
      ok: true,
      message: `Recibimos tu reporte de pago. Te enviamos un correo a ${order.buyer_email}: la verificación puede tardar hasta 24 horas y, al aprobarse, recibirás tu entrada en PDF.`,
      order: { id: order.id, status: order.status }
    });
  } catch (err) {
    console.error('Error submitting payment report:', err);
    return res.status(500).json({ ok: false, message: 'Error interno al registrar el reporte de pago.' });
  }
}, upload.single('screenshot')));

// ============================================================================
// ADMIN DASHBOARD API
// ============================================================================

// Settings as the dashboard sees them: stored mail passwords are never sent back, only whether one exists.
function adminSettings() {
  const settings = getAllSettings();
  settings.smtp_delivery_mode = mailDeliveryMode(settings);
  delete settings.secret_hmac_key;
  delete settings.admin_user;
  delete settings.admin_password_hash;
  for (const key of ['smtp_pass', 'imap_pass']) {
    settings[`${key}_set`] = Boolean(settings[key]);
    delete settings[key];
  }
  return settings;
}

app.get('/api/admin/overview', (_req, res) => {
  releaseExpiredLocks();
  const ticketsState = getAllTicketsForAdmin();
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
    campaigns,
    undeliveredEmails: undeliveredOrderEmails().length
  });
});

/**
 * Approve payment -> Marks ticket SOLD, generates unique Token & PDF with QR, then emails the buyer
 * one message that confirms the payment and carries the ticket PDF. Payment reports need `ticket_number`.
 */
app.post('/api/admin/orders/:id/approve', ticketRoute(async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { admin_notes, ticket_number } = req.body || {};
    const assignTicket = ticket_number ? parseTicketNumber(ticket_number) : null;
    if (ticket_number && !assignTicket) return res.status(400).json({ ok: false, message: 'El número de entrada no es válido.' });

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

    // Payment confirmation and the ticket with the PDF attached, in a single email
    const emailResult = await sendTicketEmail(finalOrder, pdfFullPath, pdfRelativeUrl);

    broadcastTicketsUpdate({
      name: 'admin:order_updated',
      payload: finalOrder
    });

    return res.json({
      ok: true,
      message: `Pago aprobado y entrada #${finalOrder.ticket_number} generada.` +
        (emailResult.status === 'SENT_SMTP' ? ' El servidor SMTP aceptó el correo con la entrada PDF.' : ' El correo con la entrada está pendiente de envío real. Revísalo en Correos y avisos.'),
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
}));

/**
 * Reject payment -> Releases ticket back to AVAILABLE and notifies buyer
 */
app.post('/api/admin/orders/:id/reject', ticketRoute(async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { reason } = req.body || {};

    const result = rejectOrderAtomic(orderId, reason);
    if (!result.success) {
      return res.status(400).json({ ok: false, message: result.message });
    }

    const emailResult = await sendPaymentRejectedEmail(result.order, reason);

    broadcastTicketsUpdate({
      name: 'admin:order_updated',
      payload: result.order
    });

    return res.json({
      ok: true,
      message: (result.order.ticket_number ? `Pago rechazado. La entrada #${result.order.ticket_number} vuelve a estar disponible.` : 'Reporte de pago rechazado.') +
        (emailResult.status === 'SENT_SMTP' ? ' El servidor SMTP aceptó el aviso.' : ' El aviso está pendiente de envío real. Revísalo en Correos y avisos.'),
      order: result.order
    });
  } catch (err) {
    console.error('Error rejecting order:', err);
    return res.status(500).json({ ok: false, message: err.message });
  }
}));

/**
 * Verify QR Code / Token authenticity in Admin Dashboard
 */
app.get('/api/admin/verify-qr/:rawToken', (req, res) => {
  try {
    let token = decodeURIComponent(req.params.rawToken || '').trim();
    // Extract the token from full QR links as well as from manually entered codes.
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
 * Record one arrival for the entire event.
 */
app.post('/api/admin/verify-qr/:rawToken/checkin', (req, res) => {
  try {
    let token = decodeURIComponent(req.params.rawToken || '').trim();
    if (token.includes('/verify/')) {
      token = token.split('/verify/').pop().split('?')[0].split('#')[0].trim();
    }

    const updated = db.prepare(`
      UPDATE orders SET checked_in_at = datetime('now')
      WHERE verification_token = ? AND status = 'APPROVED'
        AND checked_in_at IS NULL
        AND COALESCE(checked_in_conference, 0) = 0
        AND COALESCE(checked_in_concert, 0) = 0
      RETURNING *
    `).get(token);
    if (!updated) {
      const order = db.prepare("SELECT * FROM orders WHERE verification_token = ? AND status = 'APPROVED'").get(token);
      if (!order) return res.status(404).json({ ok: false, message: 'Token QR no válido.' });
      return res.status(409).json({
        ok: false,
        alreadyCheckedIn: true,
        message: `La asistencia para la entrada #${order.ticket_number} ya está registrada.`,
        order
      });
    }

    io.to('admins').emit('admin:order_updated', { changed: true });

    return res.json({
      ok: true,
      message: `Asistencia registrada para ${updated.buyer_name} (entrada #${updated.ticket_number}).`,
      order: updated
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// Sensitive configuration (event data, price, Pago Móvil, schedule, conditions, mail account and mass
// notices) is changed only by the superadmin; admins can see it. The scripts' account and the initial
// account, used before any user exists, keep that access.
const canEditSettings = (req) => ['superadmin', 'service', 'initial'].includes(req.admin?.role);
function superadminOnly(req, res, next) {
  if (canEditSettings(req)) return next();
  return res.status(403).json({ ok: false, message: 'Solo el superadministrador puede cambiar esta configuración.' });
}

/**
 * Update Event Settings, Terms, Conditions, Schedule, BCV & SMTP
 */
app.put('/api/admin/settings', superadminOnly, (req, res) => {
  try {
    const updates = {...(req.body || {})};
    // An empty password field means "keep the stored one" (the dashboard never receives it).
    for (const key of ['smtp_pass', 'imap_pass']) if (key in updates && !updates[key]) delete updates[key];
    const allowed = new Set(Object.keys(getAllSettings()).filter(k => k !== 'secret_hmac_key' && !k.startsWith('admin_') && (!k.startsWith('bcv_') || ['bcv_mode', 'bcv_manual_rate'].includes(k))));
    if (Object.keys(updates).some(k => !allowed.has(k))) return res.status(400).json({ok:false, message:'Parámetro no permitido.'});
    for (const key of ['ticket_price_usd', 'bcv_manual_rate', 'lock_duration_seconds', 'smtp_port', 'imap_port']) if (key in updates && (!Number.isFinite(Number(updates[key])) || Number(updates[key]) <= 0)) return res.status(400).json({ok:false, message:'Valor numérico no válido.'});
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
 * Signed-in user, the change of their own password, and the users of the panel.
 * `role` is superadmin or admin for named users; initial (no user exists yet) or service (scripts).
 */
function canResetTickets(req) {
  const account = adminAuth.sessionFrom(req)?.admin;
  return account?.role === 'superadmin' && account.email === 'soporte@merchan.dev';
}

app.get('/api/admin/session', (req, res) => res.json({
  ok: true, user: req.adminUser, role: req.admin.role, named: Boolean(req.admin.id),
  canResetTickets: canResetTickets(req),
  canEditSettings: canEditSettings(req),
  canManageUsers: req.admin.role === 'superadmin'
}));

app.post('/api/admin/tickets/reset', (req, res) => {
  if (!canResetTickets(req)) return res.status(403).json({ ok: false, message: 'Tu cuenta no puede reiniciar las entradas.' });
  if (!req.is('application/json') || req.body?.confirmation !== 'REINICIAR ENTRADAS') {
    return res.status(400).json({ ok: false, message: 'Escribe REINICIAR ENTRADAS para confirmar.' });
  }
  if (activeTicketOperations) {
    return res.status(409).json({ ok: false, message: 'Hay operaciones de entradas o correos en curso. Vuelve a intentarlo en unos segundos.' });
  }
  try {
    const result = resetTickets(db, storageDir);
    console.log(`[Entradas] Reinicio por ${req.adminUser}. Respaldo: ${result.backup}`);
    broadcastTicketsUpdate({ name: 'admin:tickets_reset', payload: { changed: true } });
    return res.json({ ok: true, message: 'Entradas reiniciadas. Las 250 están disponibles.', ...result });
  } catch (err) {
    console.error('Error resetting tickets:', err);
    return res.status(500).json({ ok: false, message: 'No se pudo completar el reinicio. Revisa el registro del servidor.' });
  }
});
app.put('/api/admin/account', adminAuth.changeAccount);
app.get('/api/admin/users', adminAuth.listUsersRoute);
app.post('/api/admin/users', adminAuth.createUserRoute);
app.put('/api/admin/users/:id/password', adminAuth.resetPasswordRoute);
app.delete('/api/admin/users/:id', adminAuth.deleteUserRoute);

app.get('/api/admin/tickets/demo.pdf', async (req, res) => {
  const source = req.query.source || 'pagina-web-1';
  if (!['pagina-web-1', 'pagina-web-2'].includes(source)) {
    return res.status(400).json({ ok: false, message: 'Elige una de las dos marcas.' });
  }
  try {
    const pdf = await generateDemoTicketPdf(source, getPublicConfig());
    const brand = source === 'pagina-web-2' ? 'marketing' : 'iluminando-caminos';
    res.set({
      'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="entrada-demo-${brand}.pdf"`,
      'X-Content-Type-Options': 'nosniff'
    });
    return res.type('application/pdf').send(pdf);
  } catch (err) {
    console.error('Error rendering demo ticket:', err.message);
    return res.status(500).json({ ok: false, message: 'No se pudo generar la vista previa.' });
  }
});

/**
 * Checks the saved SMTP and IMAP accounts and, with `to`, sends a test message.
 */
app.post('/api/admin/mail/test', superadminOnly, ticketRoute(async (req, res) => {
  try {
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ ok: false, message: 'El correo de prueba no es válido.' });
    const result = await testMailConnections(to);
    return res.json({ ok: result.smtp.ok && result.imap.ok !== false && (!result.sent || result.sent.ok), ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
}));

// Resends every buyer notice that never left (saved while the mail server was Mailpit or failing).
app.post('/api/admin/mail/retry-pending', ticketRoute(async (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ ok: false, message: 'Se requiere una solicitud JSON.' });
  if (mailDeliveryMode() !== 'smtp') return res.status(409).json({ ok: false, message: 'Configura y prueba un servidor SMTP real antes de reenviar.' });
  try {
    const { sent, failed } = await retryUndeliveredOrderEmails();
    return res.json({
      ok: failed.length === 0,
      sent,
      failed: failed.length,
      message: failed.length
        ? `Se reenviaron ${sent} aviso(s); ${failed.length} no se pudieron enviar. Revisa el registro de correos.`
        : `Se reenviaron ${sent} aviso(s) a los compradores.`
    });
  } catch (err) {
    console.error('Error retrying pending emails:', err.message);
    return res.status(500).json({ ok: false, message: 'No se pudieron reenviar los avisos.' });
  }
}));

app.post('/api/admin/mail/:id/retry', ticketRoute(async (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ ok: false, message: 'Se requiere una solicitud JSON.' });
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ ok: false, message: 'Correo inválido.' });
  try {
    const result = await retryOrderEmail(id);
    return res.status(result.ok ? 200 : 409).json(result);
  } catch (err) {
    console.error('Error retrying order email:', err.message);
    return res.status(500).json({ ok: false, message: 'No se pudo reenviar el correo.' });
  }
}));

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
app.post('/api/admin/notifications/send', superadminOnly, ticketRoute(async (req, res) => {
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
}));

// ============================================================================
// REAL-TIME SOCKET.IO & BACKGROUND TIMERS
// ============================================================================

io.on('connection', (socket) => {
  if (socket.handshake.query?.source === 'admin-dashboard') {
    try {
      if (adminAuth.sessionFrom(socket.request)) socket.join('admins');
    } catch (_) { /* Invalid cookies do not grant access to dashboard updates. */ }
  }
  const state = getReservationState(socket.handshake.query?.sessionId);
  socket.data.reservationKey = state.reservation ? `${state.reservation.ticket_number}:${state.reservation.locked_until}` : null;
  socket.emit('init:state', {
    config: getPublicConfig(),
    ...state
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
          await runTicketOperation(() => sendEventCampaignNotification(targetCampaign, 'AUTO_CRON'));
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
