require('dotenv').config();
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const cors = require('cors');
const multer = require('multer');
const { convertHeicPreview } = require('./proofPreview');
const { MAX_PROOF_BYTES, INVALID_PROOF, PROOF_EXTENSIONS, validScreenshot } = require('./paymentProof');
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
  MAX_TICKETS_PER_REFERENCE,
  activeReferenceUses,
  referenceLimitMessage,
  approveOrderAtomic,
  rejectOrderAtomic,
  getReservationState,
  getAllTicketsForAdmin
} = require('./db');
const { scrapeBcvRate } = require('./bcvScraper');
const { officialRateCurrent } = require('./bcvRate');
const { generateTicketPdf, generateDemoTicketPdf, correctedTicketPdfFilename } = require('./pdfGenerator');
const { parsePaymentForm, parseTicketNumber } = require('./paymentForm');
const { resetTickets } = require('./ticketReset');
const ticketArbitration = require('./ticketArbitration');
const campaigns = require('./campaigns');
const { registerWhatsappNoticeRoutes, whatsappNumber, ticketPdfSignature } = require('./whatsappNotices');
const {
  sendPaymentSubmittedEmail,
  sendTicketEmail,
  sendPaymentRejectedEmail,
  testMailConnections,
  mailDeliveryMode,
  retryOrderEmail,
  undeliveredOrderEmails
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

// Access-control staff only load the panel, see the ticket map, check people in at the door, read the
// scan history and change their own password. Everything else (payments, buyer contact data, proofs,
// settings, mail, blog, sponsors, users) answers 403 for them.
const ACCESS_STAFF_ROUTES = [
  ['GET', /^\/api\/admin\/session$/],
  ['GET', /^\/api\/admin\/access\/(map|history)$/],
  ['GET', /^\/api\/admin\/access\/tickets\/\d{1,3}\/pdf$/],
  ['POST', /^\/api\/admin\/access\/tickets\/\d{1,3}\/(send-email|whatsapp)$/],
  ['GET', /^\/api\/admin\/verify-qr\/[^/]+$/],
  ['POST', /^\/api\/admin\/verify-qr\/[^/]+\/checkin$/],
  ['PUT', /^\/api\/admin\/account$/]
];
const isAccessStaff = (req) => req.admin?.role === 'control';
app.use(['/admin', '/api/admin', '/storage'], (req, res, next) => {
  if (!isAccessStaff(req)) return next();
  const route = req.originalUrl.split('?')[0];
  const panelFile = req.method === 'GET' && route.startsWith('/admin') && !route.startsWith('/admin/pdfjs');
  if (panelFile || ACCESS_STAFF_ROUTES.some(([method, pattern]) => method === req.method && pattern.test(route))) return next();
  return res.status(403).json({ ok: false, message: 'Tu usuario solo tiene acceso al mapa de entradas, al control de acceso y al historial.' });
});

// What the door needs to identify the holder: no contact data, payment or proof.
function doorView(order) {
  if (!order) return order;
  const { id, ticket_number, status, buyer_name, buyer_first_name, buyer_last_name, buyer_cedula, source_web,
    verification_token, checked_in_at, checked_in_by, checked_in_conference, checked_in_concert } = order;
  return { id, ticket_number, status, buyer_name, buyer_first_name, buyer_last_name, buyer_cedula, source_web,
    verification_token, checked_in_at, checked_in_by, checked_in_conference, checked_in_concert };
}
const orderFor = (req, order) => (isAccessStaff(req) ? doorView(order) : order);
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
const issuingOrders = new Set();

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
  }).catch(err => {
    if (err.code === 'INVALID_PAYMENT_PROOF') {
      return res.status(400).json({ ok: false, field: 'screenshot', message: INVALID_PROOF });
    }
    if (err instanceof multer.MulterError) {
      const tooLarge = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        ok: false, field: 'screenshot',
        message: tooLarge ? 'La captura pesa más de 10 MB. Envía una imagen más liviana.' : 'Revisa la captura del pago y vuelve a adjuntarla.'
      });
    }
    return next(err);
  });
}

// Configure Multer for payment screenshot uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeTicket = String(req.body.ticket_number || '000').replace(/[^0-9]/g, '');
    cb(null, `pago-ticket-${safeTicket}-${Date.now()}-${randomUUID()}${ext}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (PROOF_EXTENSIONS.test(file.originalname)) return cb(null, true);
    return cb(Object.assign(new Error(INVALID_PROOF), { code: 'INVALID_PAYMENT_PROOF' }));
  },
  limits: { fileSize: MAX_PROOF_BYTES }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
require('./blog').registerBlogRoutes(app, {db, storageDir:process.env.BLOG_STORAGE_DIR || path.join(__dirname, '..', 'storage')});
require('./sponsors').registerSponsorRoutes(app, {db, storageDir:process.env.BLOG_STORAGE_DIR || path.join(__dirname, '..', 'storage')});
const googleSheets = require('./googleSheets');

// Static assets
app.use('/storage/uploads', express.static(uploadsDir, {
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (path.extname(filePath) === '.heic') {
      res.setHeader('Content-Type', 'image/heic');
      res.setHeader('Content-Disposition', 'attachment');
    }
  }
}));

let previewInProgress = false;
app.get('/api/admin/orders/:id/proof-preview', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.sendStatus(404);
  const order = db.prepare('SELECT screenshot_path FROM orders WHERE id = ?').get(id);
  const filename = /^\/storage\/uploads\/([\w-]+\.heic)$/i.exec(order?.screenshot_path || '')?.[1];
  if (!filename) return res.sendStatus(404);
  if (previewInProgress) return res.sendStatus(503);

  previewInProgress = true;
  try {
    const image = await convertHeicPreview(path.join(uploadsDir, filename));
    return res.set('X-Content-Type-Options', 'nosniff').type('jpeg').send(image);
  } catch (err) {
    console.warn('HEIC preview failed for order', id, err.code || err.name);
    return res.sendStatus(422);
  } finally {
    previewInProgress = false;
  }
});

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

const pendingAssignments = new Map();
app.post('/api/public/tickets/lock', requireSalesOpen, ticketRoute(async (req, res) => {
  const { session_id } = req.body || {};
  let assignment;
  try {
    if (typeof session_id !== 'string' || session_id.length < 8 || session_id.length > 254) {
      return res.status(400).json({
        ok: false,
        message: 'No encontramos tu sesión. Recarga la página e inténtalo de nuevo.'
      });
    }

    const source = resolveSalesSource(req);
    if (!source) return res.status(403).json({ok:false, code:'INVALID_SOURCE', message:'Solicita tu entrada desde una de las páginas de venta.'});
    assignment = pendingAssignments.get(session_id) || { requests: 0, cancelled: false };
    assignment.requests++;
    pendingAssignments.set(session_id, assignment);
    await scrapeBcvRate({maxAgeMs:5 * 60 * 1000});
    if (res.destroyed) return;
    if (assignment.cancelled) return res.status(409).json({ok:false, code:'RESERVATION_CANCELLED', message:'Se canceló la solicitud de entrada.'});
    const current = getPublicConfig();
    if (current.bcv_mode !== 'manual' && !officialRateCurrent(current)) return res.status(503).json({ok:false, code:'BCV_UNAVAILABLE', message:'No hay una tasa oficial BCV reciente confirmada. Intenta nuevamente más tarde.'});

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
  } finally {
    if (assignment && --assignment.requests === 0) pendingAssignments.delete(session_id);
  }
}));

/**
 * Voluntary unlock endpoint (if buyer explicitly clicks "Cambiar de entrada / Cancelar")
 */
app.post('/api/public/tickets/unlock', (req, res) => {
  try {
    const { ticket_number, session_id } = req.body;
    const ticket = ticket_number == null ? null : parseTicketNumber(ticket_number);
    if ((ticket_number != null && !ticket) || typeof session_id !== 'string' || session_id.length < 8 || session_id.length > 254) {
      return res.status(400).json({ ok: false, message: 'Faltan datos.' });
    }
    const assignment = pendingAssignments.get(session_id);
    if (assignment && !ticket) assignment.cancelled = true;
    const result = unlockTicketAtomic(ticket, session_id);
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
  const filename = `pago-${label}-${randomUUID()}.png`;
  fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(req.body.screenshot_base64.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
  return `/storage/uploads/${filename}`;
}
const hasScreenshot = (req) => Boolean(req.file || req.body.screenshot_base64);
const MISSING_SCREENSHOT = { ok: false, field: 'screenshot', message: INVALID_PROOF };

// The buy widget sends one key per purchase attempt and keeps it until the payment is received,
// so resending the form (lost connection, reload) returns the same order instead of a new one.
// Buyers may repeat names, ID numbers and references: each new attempt is a new ticket.
function submissionKey(req) {
  const key = typeof req.body.submission_id === 'string' ? req.body.submission_id.trim() : '';
  return /^[A-Za-z0-9_-]{8,80}$/.test(key) ? key : null;
}

function existingPayment(submissionId) {
  if (!submissionId) return null;
  const order = db.prepare(`
    SELECT id, ticket_number, status FROM orders
    WHERE submission_id = ? AND status IN ('PENDING', 'APPROVED')
    ORDER BY id DESC LIMIT 1
  `).get(submissionId);
  if (!order) return null;
  return {
    ok: true, order,
    message: order.status === 'APPROVED' ? 'Este pago ya fue aprobado.' : 'Ya recibimos este pago. Está pendiente de verificación.'
  };
}

function discardUnstoredProof(req, screenshotPath) {
  const file = req.file?.path || (screenshotPath && path.join(uploadsDir, path.basename(screenshotPath)));
  if (file) fs.unlink(file, () => {});
}

function notifyPaymentReceived(order) {
  sendInBackground(() => sendPaymentSubmittedEmail(order));
  googleSheets.syncOrder(order);
  broadcastTicketsUpdate({ name: 'admin:order_created' });
}

function paymentReportReceipt(order) {
  return {
    ok: true,
    message: `Recibimos tu reporte de pago #${order.id}. Te avisaremos a ${order.buyer_email} cuando se verifique y se asigne una entrada.`,
    order: { id: order.id, status: order.status }
  };
}

/**
 * Payment form of the checkout popup: buyer data + Pago Móvil reference for the ticket locked by this session.
 */
app.post('/api/public/orders', requireSalesOpen, ticketRoute(async (req, res) => {
  let screenshotPath;
  let stored = false;
  try {
    const source = resolveSalesSource(req);
    if (!source) return res.status(403).json({ok:false, code:'INVALID_SOURCE', message:'Reporta el pago desde una de las páginas de venta.'});
    const ticketNumber = parseTicketNumber(req.body.ticket_number);
    const sessionId = req.body.session_id;
    if (!ticketNumber || typeof sessionId !== 'string' || sessionId.length < 8 || sessionId.length > 254) {
      return res.status(400).json({ ok: false, message: 'Solicita que te asignemos una entrada antes de reportar el pago.' });
    }
    const form = parsePaymentForm(req.body);
    if (!form.ok) return res.status(400).json({ ok: false, field: form.field, message: form.message });
    const submissionId = submissionKey(req);
    const existing = existingPayment(submissionId);
    if (existing) return res.json(existing);
    if (activeReferenceUses(form.data.payment_reference, form.data.payment_bank) >= MAX_TICKETS_PER_REFERENCE) {
      return res.status(400).json({ ok: false, field: 'payment_reference', message: referenceLimitMessage(form.data.payment_reference) });
    }
    if (!validScreenshot(req)) return res.status(400).json(MISSING_SCREENSHOT);
    if (!hasScreenshot(req)) return res.status(400).json(MISSING_SCREENSHOT);

    const config = getPublicConfig();
    screenshotPath = saveScreenshot(req, 'ticket-' + ticketNumber);
    const payment = {
      source_web: source,
      session_id: sessionId,
      submission_id: submissionId,
      ...form.data,
      screenshot_path: screenshotPath,
      amount_usd: config.ticket_price_usd,
      bcv_rate: config.bcv_rate,
      amount_ves: config.ticket_price_ves
    };
    const submitResult = submitOrderAtomic({ ...payment, ticket_number: ticketNumber });
    if (!submitResult.success) {
      const report = submitPaymentReport({ ...payment, requested_ticket: ticketNumber,
        buyer_comment: 'Pago enviado cuando la reserva ya no estaba vigente.' });
      stored = true;
      res.status(201).json(paymentReportReceipt(report));
      notifyPaymentReceived(report);
      return;
    }

    stored = true;

    const { id, buyer_email: email, status } = submitResult.order;
    res.status(201).json({
      ok: true,
      message: `Recibimos el pago de tu entrada #${ticketNumber}. Te avisaremos a ${email}: la verificación puede tardar hasta 24 horas y, al aprobarse, recibirás tu entrada en PDF.`,
      order: { id, ticket_number: ticketNumber, buyer_email: email, status }
    });
    notifyPaymentReceived(submitResult.order);
  } catch (err) {
    console.error('Error submitting order:', err);
    if (res.headersSent) return;
    return res.status(500).json({ ok: false, message: 'Error interno al procesar la compra.' });
  } finally {
    if (!stored) discardUnstoredProof(req, screenshotPath);
  }
}, upload.single('screenshot')));

/**
 * Standalone payment report ("Reporte de pago"), for buyers who paid but could not finish the popup.
 * No ticket is held: the administrator assigns an available one when approving it.
 */
app.post('/api/public/payment-reports', requireSalesOpen, ticketRoute(async (req, res) => {
  let screenshotPath;
  let stored = false;
  try {
    const source = resolveSalesSource(req);
    if (!source) return res.status(403).json({ok:false, code:'INVALID_SOURCE', message:'Reporta el pago desde una de las páginas de venta.'});
    const form = parsePaymentForm(req.body);
    if (!form.ok) return res.status(400).json({ ok: false, field: form.field, message: form.message });
    const requested = parseTicketNumber(req.body.requested_ticket);
    if (String(req.body.requested_ticket ?? '').trim() && !requested) return res.status(400).json({ ok: false, field: 'requested_ticket', message: 'Revisa el número de entrada o deja el campo vacío si no lo tienes.' });
    const comment = typeof req.body.buyer_comment === 'string' ? req.body.buyer_comment.trim().slice(0, 500) : '';
    if (comment.length < 3) return res.status(400).json({ ok: false, field: 'buyer_comment', message: 'Cuéntanos brevemente qué pasó con tu pago.' });
    const submissionId = submissionKey(req);
    const existing = existingPayment(submissionId);
    if (existing) return res.json(existing);
    if (activeReferenceUses(form.data.payment_reference, form.data.payment_bank) >= MAX_TICKETS_PER_REFERENCE) {
      return res.status(400).json({ ok: false, field: 'payment_reference', message: referenceLimitMessage(form.data.payment_reference) });
    }
    if (!validScreenshot(req)) return res.status(400).json(MISSING_SCREENSHOT);
    if (!hasScreenshot(req)) return res.status(400).json(MISSING_SCREENSHOT);

    const config = getPublicConfig();
    const sessionId = typeof req.body.session_id === 'string' && req.body.session_id.length <= 254 ? req.body.session_id : '';
    screenshotPath = saveScreenshot(req, 'reporte');
    const order = submitPaymentReport({
      source_web: source,
      session_id: sessionId || 'reporte',
      submission_id: submissionId,
      ...form.data,
      screenshot_path: screenshotPath,
      amount_usd: config.ticket_price_usd,
      bcv_rate: config.bcv_rate,
      amount_ves: config.ticket_price_ves,
      requested_ticket: requested,
      buyer_comment: comment
    });

    stored = true;
    res.status(201).json(paymentReportReceipt(order));
    if (sessionId) unlockTicketAtomic(null, sessionId);
    notifyPaymentReceived(order);
  } catch (err) {
    console.error('Error submitting payment report:', err);
    if (res.headersSent) return;
    return res.status(500).json({ ok: false, message: 'Error interno al registrar el reporte de pago.' });
  } finally {
    if (!stored) discardUnstoredProof(req, screenshotPath);
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
  for (const key of ['smtp_pass', 'imap_pass', 'smtp2_pass', 'sheets_secret']) {
    settings[`${key}_set`] = Boolean(settings[key]);
    delete settings[key];
  }
  return settings;
}

app.get('/api/admin/overview', (req, res) => {
  releaseExpiredLocks();
  const ticketsState = getAllTicketsForAdmin();
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
  const emailLogs = db.prepare(`SELECT * FROM email_logs WHERE (? OR type != 'TICKET_DETAILS_CORRECTION') ORDER BY id DESC LIMIT 100`)
    .all(Number(canArbitrateTickets(req)));
  const undelivered = undeliveredOrderEmails();
  const campaignHistory = db.prepare('SELECT * FROM notification_campaigns ORDER BY id DESC LIMIT 50').all();
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
  let verifiedVesCents = 0;
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
      const paidVesCents = Math.round(Number(o.amount_ves || 0) * 100);
      summary.revenue_ves += paidVesCents;
      counts.revenue_usd += Number(o.amount_usd || 0);
      verifiedVesCents += paidVesCents;
      if (o.source_web === 'pagina-web-1') counts.sold_web_1++;
      if (o.source_web === 'pagina-web-2') counts.sold_web_2++;
    }
  }

  counts.revenue_ves = verifiedVesCents / 100;
  for (const source of Object.values(salesBySource)) source.revenue_ves /= 100;

  res.json({
    ok: true,
    counts,
    salesBySource,
    publicConfig,
    settings: rawSettings,
    tickets: ticketsState.tickets,
    orders,
    emailLogs,
    campaigns: campaignHistory,
    campaignSchedule: campaigns.status(),
    mailResend: campaigns.resendStatus(),
    undeliveredEmails: undelivered.length,
    retryableEmailIds: undelivered.map(log => log.id)
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

    return res.json(await issueApprovedTicket(result.order));
  } catch (err) {
    console.error('Error approving order:', err);
    return res.status(500).json({ ok: false, message: err.message });
  }
}));

async function issueApprovedTicket(order) {
  issuingOrders.add(order.id);
  try {
    const { pdfFullPath, pdfRelativeUrl, qrDataUrl, verificationUrl } = await generateTicketPdf(order, getPublicConfig(), PUBLIC_BASE_URL);
    db.prepare('UPDATE orders SET pdf_path = ? WHERE id = ?').run(pdfRelativeUrl, order.id);
    const finalOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    const emailResult = await sendTicketEmail(finalOrder, pdfFullPath, pdfRelativeUrl);
    return {
      ok: true,
      message: `Pago aprobado y entrada #${finalOrder.ticket_number} generada.` +
        (emailResult.status === 'SENT_SMTP' ? ' El servidor SMTP aceptó el correo con la entrada PDF.' : ' El correo con la entrada está pendiente de envío real. Revísalo en Correos y avisos.'),
      order: finalOrder, pdfUrl: pdfRelativeUrl, qrDataUrl, verificationUrl, emailResult
    };
  } finally {
    issuingOrders.delete(order.id);
    broadcastTicketsUpdate({ name: 'admin:order_updated' });
  }
}

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
        order: orderFor(req, order),
        message: `⚠️ ENTRADA NO ACTIVA: La orden asociada a este token tiene estado "${order.status}".`
      });
    }

    return res.json({
      ok: true,
      valid: true,
      token,
      message: `✅ ENTRADA AUTÉNTICA Y VERIFICADA (#${order.ticket_number}) - Titular: ${order.buyer_name} (C.I. ${order.buyer_cedula})`,
      order: orderFor(req, order)
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
      UPDATE orders SET checked_in_at = datetime('now'), checked_in_by = ?
      WHERE verification_token = ? AND status = 'APPROVED'
        AND checked_in_at IS NULL
        AND COALESCE(checked_in_conference, 0) = 0
        AND COALESCE(checked_in_concert, 0) = 0
      RETURNING *
    `).get(req.adminUser || 'panel', token);
    if (!updated) {
      const order = db.prepare("SELECT * FROM orders WHERE verification_token = ? AND status = 'APPROVED'").get(token);
      if (!order) return res.status(404).json({ ok: false, message: 'Token QR no válido.' });
      return res.status(409).json({
        ok: false,
        alreadyCheckedIn: true,
        message: `La asistencia para la entrada #${order.ticket_number} ya está registrada${order.checked_in_by ? ` por ${order.checked_in_by}` : ''}.`,
        order: orderFor(req, order)
      });
    }

    io.to('admins').emit('admin:order_updated', { changed: true });

    return res.json({
      ok: true,
      message: `Asistencia registrada para ${updated.buyer_name} (entrada #${updated.ticket_number}).`,
      order: orderFor(req, updated)
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
    for (const key of ['smtp_pass', 'imap_pass', 'smtp2_pass', 'sheets_secret']) if (key in updates && !updates[key]) delete updates[key];
    delete updates.sheets_last_status;
    for (const key of ['sheets_webapp_url', 'sheets_sheet_url']) if (typeof updates[key] === 'string') updates[key] = updates[key].trim();
    if (updates.sheets_webapp_url && !googleSheets.validWebAppUrl(updates.sheets_webapp_url)) return res.status(400).json({ ok: false, field: 'sheets_webapp_url', message: 'La URL de la aplicación web debe ser como https://script.google.com/macros/s/…/exec.' });
    if (updates.sheets_sheet_url && !googleSheets.validSheetUrl(updates.sheets_sheet_url)) return res.status(400).json({ ok: false, field: 'sheets_sheet_url', message: 'El enlace de la hoja debe ser como https://docs.google.com/spreadsheets/d/…' });
    const allowed = new Set(Object.keys(getAllSettings()).filter(k => k !== 'secret_hmac_key' && !k.startsWith('admin_') && (!k.startsWith('bcv_') || ['bcv_mode', 'bcv_manual_rate'].includes(k))));
    if (Object.keys(updates).some(k => !allowed.has(k))) return res.status(400).json({ok:false, message:'Parámetro no permitido.'});
    for (const key of ['ticket_price_usd', 'bcv_manual_rate', 'lock_duration_seconds', 'smtp_port', 'imap_port', 'smtp2_port']) if (key in updates && (!Number.isFinite(Number(updates[key])) || Number(updates[key]) <= 0)) return res.status(400).json({ok:false, message:'Valor numérico no válido.'});
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

function canArbitrateTickets(req) {
  return adminAuth.sessionFrom(req)?.admin?.role === 'superadmin';
}

app.get('/api/admin/session', (req, res) => res.json({
  ok: true, user: req.adminUser, role: req.admin.role, named: Boolean(req.admin.id),
  canResetTickets: canResetTickets(req),
  canArbitrateTickets: canArbitrateTickets(req),
  canEditSettings: canEditSettings(req),
  canManageUsers: req.admin.role === 'superadmin',
  accessOnly: isAccessStaff(req)
}));

// Ticket map for the door: status of every ticket and, for sold ones, holder and arrival.
app.get('/api/admin/access/map', (req, res) => {
  const { serverTime, tickets } = getAllTicketsForAdmin();
  const safe = tickets.map(t => ({
    ticket_number: t.ticket_number, status: t.status, locked_until: t.locked_until, remaining_seconds: t.remaining_seconds,
    locked_by_source: t.locked_by_source, checked_in_at: t.checked_in_at, checked_in_by: t.checked_in_by,
    buyer_name: t.status === 'SOLD' ? t.buyer_name : null, buyer_cedula: t.status === 'SOLD' ? t.buyer_cedula : null,
    email_hint: t.status === 'SOLD' ? maskEmail(t.buyer_email) : null,
    order_source: t.status === 'SOLD' ? t.order_source : null
  }));
  const checkedIn = safe.filter(t => t.checked_in_at).length;
  res.json({ ok: true, serverTime, tickets: safe, counts: { sold: safe.filter(t => t.status === 'SOLD').length, checkedIn } });
});

// PDF of a sold ticket (the current one, corrected if it was reissued), so the door staff can send it
// to a guest who could not download it. ?descargar=1 saves it instead of opening it.
app.get('/api/admin/access/tickets/:number/pdf', (req, res) => {
  const number = parseTicketNumber(req.params.number);
  const order = number && db.prepare(`
    SELECT o.id, o.ticket_number, o.pdf_path FROM tickets t JOIN orders o ON o.id = t.current_order_id
    WHERE t.ticket_number = ? AND t.status = 'SOLD' AND o.status = 'APPROVED'
  `).get(number);
  const filename = /^\/storage\/tickets\/([\w-]+\.pdf)$/.exec(order?.pdf_path || '')?.[1];
  const file = filename && path.join(ticketsDir, filename);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ ok: false, message: 'Esta entrada no tiene un PDF emitido.' });
  console.log(`[Puerta] ${req.adminUser} abrió el PDF de la entrada #${number}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `${req.query.descargar ? 'attachment' : 'inline'}; filename="Entrada-${number}.pdf"`);
  return res.type('application/pdf').sendFile(file);
});

// "ana.perez@gmail.com" -> "an•••@gmail.com": enough for the door to confirm the address with the guest.
function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!user || !domain) return null;
  return `${user.slice(0, Math.min(2, user.length))}•••@${domain}`;
}

// Sends the ticket email with its current PDF again (the corrected one if it was reissued), from the map.
// If the provider refuses it, the notice stays pending and the automatic resend keeps trying.
const forcedSends = new Map();
const FORCED_SEND_GAP_MS = 60 * 1000;
app.post('/api/admin/access/tickets/:number/send-email', ticketRoute(async (req, res) => {
  const number = parseTicketNumber(req.params.number);
  const order = number && db.prepare(`
    SELECT o.* FROM tickets t JOIN orders o ON o.id = t.current_order_id
    WHERE t.ticket_number = ? AND t.status = 'SOLD' AND o.status = 'APPROVED'
  `).get(number);
  const filename = /^\/storage\/tickets\/([\w-]+\.pdf)$/.exec(order?.pdf_path || '')?.[1];
  const pdfPath = filename && path.join(ticketsDir, filename);
  if (!order || !pdfPath || !fs.existsSync(pdfPath)) return res.status(404).json({ ok: false, message: 'Esta entrada no tiene un PDF emitido para enviar.' });
  if (mailDeliveryMode() !== 'smtp') return res.status(409).json({ ok: false, message: 'Configura un servidor SMTP real antes de enviar entradas.' });
  const recipient = isAccessStaff(req) ? maskEmail(order.buyer_email) : order.buyer_email;
  const lastSend = forcedSends.get(order.id) || 0;
  if (issuingOrders.has(order.id) || Date.now() - lastSend < FORCED_SEND_GAP_MS) {
    return res.status(429).json({ ok: false, message: `La entrada #${number} se acaba de enviar. Espera un minuto antes de enviarla de nuevo.` });
  }
  issuingOrders.add(order.id);
  forcedSends.set(order.id, Date.now());
  try {
    const corrected = Boolean(correctedTicketPdfFilename(order));
    const result = await sendTicketEmail(order, pdfPath, order.pdf_path, { correctedDetails: corrected });
    console.log(`[Puerta] ${req.adminUser} envió por correo la entrada #${number}: ${result.status}`);
    broadcastTicketsUpdate({ name: 'admin:order_updated' });
    if (result.status === 'SENT_SMTP') return res.json({ ok: true, message: `Listo: el servidor de correo aceptó la entrada #${number} para ${recipient}. Pídele al invitado que revise también la carpeta de spam.` });
    const limited = campaigns.RATE_LIMITED.test(result.errorMessage || '');
    return res.status(502).json({ ok: false, message: limited
      ? `El proveedor de correo está limitando los envíos. La entrada #${number} quedó en cola y se reintenta sola cada 3 minutos; mientras tanto puedes compartir el PDF por WhatsApp.`
      : `No se pudo enviar la entrada #${number} a ${recipient}: ${result.errorMessage || 'error desconocido'}.` });
  } catch (err) {
    console.error('Error sending ticket from the map:', err);
    return res.status(500).json({ ok: false, message: 'No se pudo confirmar el envío. Revisa el registro de correos.' });
  } finally {
    issuingOrders.delete(order.id);
  }
}));

// Public link to one ticket's PDF for a WhatsApp message, signed so it cannot be guessed and valid only
// while the ticket stays sold to that order (a new QR or a cancellation invalidates it).
app.get('/verify/entrada/:id/:signature', (req, res) => {
  const order = db.prepare(`SELECT o.* FROM orders o JOIN tickets t ON t.current_order_id = o.id AND t.status = 'SOLD'
    WHERE o.id = ? AND o.status = 'APPROVED'`).get(Number(req.params.id) || 0);
  const expected = order?.verification_token && ticketPdfSignature(order);
  const given = String(req.params.signature || '').replace(/\.pdf$/, '');
  const filename = /^\/storage\/tickets\/([\w-]+\.pdf)$/.exec(order?.pdf_path || '')?.[1];
  const file = filename && path.join(ticketsDir, filename);
  if (!expected || given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected)) || !file || !fs.existsSync(file)) {
    return res.status(404).type('text/plain').send('Este enlace de entrada no es válido o la entrada cambió. Pide un enlace nuevo al equipo del evento.');
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Content-Disposition', `inline; filename="Entrada-${order.ticket_number}.pdf"`);
  return res.type('application/pdf').sendFile(file);
});

const twelveHour = (time) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  return m ? `${Number(m[1]) % 12 || 12}:${m[2]} ${Number(m[1]) >= 12 ? 'PM' : 'AM'}` : time || '';
};

// WhatsApp message for a sold ticket: the panel opens wa.me with this number and text (link to the PDF).
app.post('/api/admin/access/tickets/:number/whatsapp', (req, res) => {
  const number = parseTicketNumber(req.params.number);
  const order = number && db.prepare(`SELECT o.* FROM tickets t JOIN orders o ON o.id = t.current_order_id
    WHERE t.ticket_number = ? AND t.status = 'SOLD' AND o.status = 'APPROVED'`).get(number);
  if (!order?.verification_token || !order.pdf_path) return res.status(404).json({ ok: false, message: 'Esta entrada no tiene un PDF emitido.' });
  const phone = whatsappNumber(req.body?.phone);
  if (!phone) return res.status(400).json({ ok: false, field: 'phone', message: 'Escribe un número de WhatsApp válido, por ejemplo 0414-1234567.' });
  const cfg = getPublicConfig();
  const link = `${PUBLIC_BASE_URL}/verify/entrada/${order.id}/${ticketPdfSignature(order)}.pdf`;
  const name = order.buyer_first_name || String(order.buyer_name || '').split(' ')[0];
  const text = [
    `Hola ${name}, te enviamos tu entrada #${number} para ${cfg.event_title}.`,
    `El acceso y registro comienzan a las ${twelveHour(cfg.event_entry_time || '15:00')} en ${cfg.event_location}.`,
    `Descarga tu entrada en PDF aquí: ${link}`,
    'Muestra el código QR y tu cédula en el acceso. ¡Te esperamos!'
  ].join('\n\n');
  console.log(`[Puerta] ${req.adminUser} preparó el WhatsApp de la entrada #${number}`);
  return res.json({ ok: true, url: `https://wa.me/${phone}?text=${encodeURIComponent(text)}`, link, text });
});

// Event notices by WhatsApp for every registered number (see whatsappNotices.js)
registerWhatsappNoticeRoutes(app, { baseUrl: PUBLIC_BASE_URL });

// Who checked in each ticket and when, newest first.
app.get('/api/admin/access/history', (req, res) => {
  const entries = db.prepare(`
    SELECT ticket_number, buyer_name, buyer_cedula, source_web, checked_in_at, checked_in_by
    FROM orders WHERE status = 'APPROVED' AND checked_in_at IS NOT NULL
    ORDER BY checked_in_at DESC, id DESC
  `).all();
  res.json({ ok: true, entries });
});

function requireTicketArbitration(req, res, next) {
  if (!canArbitrateTickets(req)) return res.status(403).json({ ok: false, message: 'El arbitraje de entradas requiere una sesión de superadministrador.' });
  if (req.method === 'POST' && req.get('origin')) {
    try {
      if (new URL(req.get('origin')).host === req.get('host')) return next();
    } catch (_) { /* invalid origin */ }
    return res.status(403).json({ ok: false, message: 'Abre el mapa desde el dominio del panel para continuar.' });
  }
  return next();
}

app.get('/api/admin/tickets/:number/arbitration', requireTicketArbitration, (req, res) => {
  releaseExpiredLocks();
  const details = ticketArbitration.getTicket(parseTicketNumber(req.params.number));
  if (!details) return res.status(404).json({ ok: false, message: 'Entrada no encontrada.' });
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, revision: details.revision, manualHold: details.manualHold,
    status: details.ticket.status, source: details.ticket.locked_by_source, lockedUntil: details.ticket.locked_until, order: details.order,
    pdfResendHistory: ticketArbitration.getPdfResendHistory(details.ticket.ticket_number),
    canResendCorrectedPdf: details.ticket.status === 'SOLD' && details.order?.status === 'APPROVED' && Boolean(correctedTicketPdfFilename(details.order)) });
});

app.post('/api/admin/tickets/:number/arbitration/resend-pdf', requireTicketArbitration, ticketRoute(async (req, res) => {
  const number = parseTicketNumber(req.params.number);
  const revision = req.body?.revision;
  if (!number || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) {
    return res.status(400).json({ ok: false, message: 'Abre de nuevo el detalle de la entrada.' });
  }
  const current = ticketArbitration.checkTicket(number, revision);
  if (!current.ok) return res.status(409).json(current);
  const { order, ticket } = current;
  const filename = correctedTicketPdfFilename(order);
  if (ticket.status !== 'SOLD' || order?.status !== 'APPROVED' || !order.verification_token || !filename) {
    return res.status(409).json({ ok: false, message: 'Esta entrada no tiene un PDF corregido disponible para reenviar.' });
  }
  if (issuingOrders.has(order.id)) {
    return res.status(409).json({ ok: false, message: 'Ya hay un envío en curso para esta entrada.' });
  }
  issuingOrders.add(order.id);
  let attemptId;
  try {
    attemptId = ticketArbitration.startPdfResend(order, req.adminUser);
    if (mailDeliveryMode() !== 'smtp') {
      const message = 'Configura un servidor SMTP real antes de reenviar el PDF.';
      ticketArbitration.finishPdfResend(attemptId, 'ERROR', message);
      return res.status(409).json({ ok: false, message });
    }
    const pdfPath = path.join(ticketsDir, filename);
    if (!fs.existsSync(pdfPath)) {
      const message = 'No se encontró el PDF corregido.';
      ticketArbitration.finishPdfResend(attemptId, 'ERROR', message);
      return res.status(404).json({ ok: false, message });
    }
    const result = await sendTicketEmail(order, pdfPath, order.pdf_path, { correctedDetails: true });
    ticketArbitration.finishPdfResend(attemptId, result.status, result.errorMessage);
    if (result.status !== 'SENT_SMTP') {
      return res.status(502).json({ ok: false, message: 'El servidor de correo no aceptó el PDF. Revisa el registro de correos.' });
    }
    return res.json({ ok: true, message: `El servidor de correo aceptó el PDF para ${order.buyer_email}.` });
  } catch (err) {
    console.error('Error resending corrected PDF:', err);
    if (attemptId) ticketArbitration.finishPdfResend(attemptId, 'UNKNOWN', 'No se pudo confirmar el resultado del reenvío.');
    return res.status(500).json({ ok: false, message: 'No se pudo confirmar el reenvío. Revisa el registro de correos.' });
  } finally {
    issuingOrders.delete(order.id);
  }
}));

const arbitrationMessages = {
  hold: 'Entrada bloqueada manualmente.', release: 'Entrada liberada para la venta.',
  cancel: 'Orden anulada y entrada liberada.', assist: 'Pago registrado y pendiente de verificación.', edit: 'Datos de la orden actualizados.'
};

app.post('/api/admin/tickets/:number/arbitration', requireTicketArbitration, ticketRoute(async (req, res) => {
  const number = parseTicketNumber(req.params.number);
  const { action, revision, confirmation, source } = req.body || {};
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  let saved = false;
  let revisedPdfPath;
  try {
    if (!number || !/^[a-f0-9]{64}$/.test(revision || '') || (action !== 'approve' && !Object.hasOwn(arbitrationMessages, action))) {
      return res.status(400).json({ ok: false, message: 'Revisa el número de entrada y la acción solicitada.' });
    }
    if (reason.length < 3 || reason.length > 500) return res.status(400).json({ ok: false, message: 'Escribe un motivo de 3 a 500 caracteres.' });
    const current = ticketArbitration.checkTicket(number, revision);
    if (!current.ok) return res.status(409).json(current);
    if (current.order && issuingOrders.has(current.order.id)) {
      return res.status(409).json({ ok: false, message: 'La entrada se está emitiendo. Vuelve a abrirla cuando termine el envío.' });
    }
    if (action === 'cancel' && confirmation !== `ANULAR ${number}`) {
      return res.status(400).json({ ok: false, message: `Escribe ANULAR ${number} para confirmar.` });
    }
    if (action === 'approve') {
      if (current.ticket.status !== 'PENDING' || !current.order) {
        return res.status(409).json({ ok: false, message: 'La entrada no tiene un pago pendiente.' });
      }
      const approved = approveOrderAtomic(current.order.id, reason, null,
        order => ticketArbitration.audit(number, order.id, req.adminUser, action, reason));
      if (!approved.success) return res.status(409).json({ ok: false, message: approved.message });
      return res.json(await issueApprovedTicket(approved.order));
    }

    let payment;
    if (action === 'assist' || action === 'edit') {
      if (req.file && !validScreenshot(req)) return res.status(400).json(MISSING_SCREENSHOT);
      const parsed = parsePaymentForm(req.body);
      if (!parsed.ok) return res.status(400).json(parsed);
      payment = parsed.data;
      if (action === 'edit' && current.order) {
        const paymentPhone = req.body.payment_phone;
        if (typeof paymentPhone === 'string' && paymentPhone.trim() !== current.order.payment_phone) {
          const digits = paymentPhone.replace(/\D/g, '');
          if (!/^\+?[\d\s()-]+$/.test(paymentPhone.trim()) || digits.length < 10 || digits.length > 13) {
            return res.status(400).json({ ok: false, message: 'Revisa el teléfono utilizado para pagar.' });
          }
          payment.payment_phone = paymentPhone.trim();
        } else {
          payment.payment_phone = current.order.payment_phone;
        }
        payment.buyer_comment = typeof req.body.buyer_comment === 'string' ? req.body.buyer_comment.trim().slice(0, 500) || null : current.order.buyer_comment;
      }
      if (action === 'assist') {
        if (!['pagina-web-1', 'pagina-web-2'].includes(source)) return res.status(400).json({ ok: false, message: 'Elige la página de origen.' });
        if (!req.file) return res.status(400).json(MISSING_SCREENSHOT);
      }
    }

    let pdfPath;
    if (action === 'edit' && current.order?.status === 'APPROVED') {
      const fileRevision = randomUUID();
      revisedPdfPath = path.join(ticketsDir, `ENTRADA-${number}-ORD${current.order.id}-${fileRevision}.pdf`);
      const pdf = await generateTicketPdf({ ...current.order, ...payment }, getPublicConfig(), PUBLIC_BASE_URL, ticketsDir, fileRevision);
      pdfPath = pdf.pdfRelativeUrl;
      if (issuingOrders.has(current.order.id)) {
        return res.status(409).json({ ok: false, message: 'Hay un envío en curso para esta entrada. Intenta de nuevo al terminar.' });
      }
    }
    const result = ticketArbitration.applyAction(number, { action, revision, reason, actor: req.adminUser,
      source, payment, screenshot: req.file && payment ? saveScreenshot(req, number) : null, pdfPath });
    if (!result.ok) return res.status(409).json(result);
    saved = true;
    if (action === 'assist') {
      sendInBackground(() => sendPaymentSubmittedEmail(result.order));
      googleSheets.syncOrder(result.order);
    }
    broadcastTicketsUpdate({ name: action === 'assist' ? 'admin:order_created' : 'admin:order_updated' });
    return res.json({ ok: true, message: arbitrationMessages[action] });
  } catch (err) {
    console.error('Ticket arbitration failed:', err);
    return res.status(500).json({ ok: false, message: 'No se pudo completar la operación. Vuelve a abrir la entrada para confirmar su estado.' });
  } finally {
    if ((!saved || !['assist', 'edit'].includes(action)) && req.file) fs.unlink(req.file.path, () => {});
    if (!saved && revisedPdfPath) fs.unlink(revisedPdfPath, () => {});
  }
}, upload.single('screenshot')));

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
    const result = await testMailConnections(to, req.body?.account === 'respaldo' ? 'respaldo' : 'principal');
    return res.json({ ok: result.smtp.ok && result.imap?.ok !== false && (!result.sent || result.sent.ok), ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
}));

// Resends every buyer notice that never left (saved while the mail server was Mailpit or failing).
// "Reenviar ahora": starts resending every undelivered notice in the background (campaigns.js), one by
// one; the panel follows the progress. The same resend also runs on its own every 3 minutes.
app.post('/api/admin/mail/retry-pending', (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ ok: false, message: 'Se requiere una solicitud JSON.' });
  const { status = 200, ...result } = campaigns.forceResend();
  return res.status(status).json({ ...result, resend: campaigns.resendStatus() });
});

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
// Payment control sheet in Google Sheets: check the connection, or send every payment again
app.post('/api/admin/sheets/test', superadminOnly, async (_req, res) => {
  const result = await googleSheets.testConnection();
  return res.status(result.ok ? 200 : 502).json(result);
});
app.post('/api/admin/sheets/sync-all', superadminOnly, async (_req, res) => {
  const result = await googleSheets.syncAll();
  return res.status(result.ok ? 200 : 502).json({ ...result, settings: adminSettings() });
});

// Pauses or resumes the automatic event reminders (ticket and payment emails always go out).
app.post('/api/admin/notifications/pause', superadminOnly, (req, res) => {
  if (typeof req.body?.paused !== 'boolean') return res.status(400).json({ ok: false, message: 'Indica si los recordatorios quedan en pausa.' });
  return res.json({ ...campaigns.setPaused(req.body.paused), campaigns: campaigns.status() });
});

// Queues a reminder for the buyers who have not received it; campaigns.js sends it one by one.
app.post('/api/admin/notifications/send', superadminOnly, (req, res) => {
  const { status = 200, ...result } = campaigns.queueCampaign(req.body?.campaign_key);
  return res.status(status).json({ ...result, campaigns: campaigns.status() });
});

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

});

// Release expired reservations and notify the affected sessions.
setInterval(() => {
  const expired = releaseExpiredLocks();
  if (expired.length > 0) {
    broadcastTicketsUpdate({
      name: 'tickets:expired',
      payload: expired
    });
  }
}, 1000);

// Scheduled event reminders and automatic resends of undelivered notices (see campaigns.js); the panel
// refreshes as messages go out, at most every 2 seconds.
let mailProgressTimer = null;
campaigns.onProgress(() => {
  if (mailProgressTimer) return;
  mailProgressTimer = setTimeout(() => { mailProgressTimer = null; io.to('admins').emit('admin:order_updated', { changed: true }); }, 2000);
});
campaigns.start();

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
