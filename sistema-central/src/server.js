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
  approveOrderAtomic,
  rejectOrderAtomic,
  getAllTicketsPublic
} = require('./db');
const { scrapeBcvRate } = require('./bcvScraper');
const { generateTicketPdf } = require('./pdfGenerator');
const {
  sendPaymentSubmittedEmail,
  sendTicketApprovedEmail,
  sendPaymentRejectedEmail,
  sendEventCampaignNotification
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
      message: `Entrada #${paddedNumber} reservada temporalmente por 3 minutos.`,
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

/**
 * Submit payment verification form + screenshot
 */
app.post('/api/public/orders', requireSalesOpen, upload.single('screenshot'), async (req, res) => {
  try {
    if (!resolveSalesSource(req)) return res.status(403).json({ok:false, code:'INVALID_SOURCE', message:'Reporta el pago desde una de las paginas de venta.'});
    const {
      ticket_number,
      source_web,
      session_id,
      buyer_name,
      buyer_cedula,
      buyer_phone,
      buyer_email,
      payment_phone,
      payment_reference
    } = req.body;

    if (
      !ticket_number ||
      !session_id ||
      !buyer_name ||
      !buyer_cedula ||
      !buyer_phone ||
      !buyer_email ||
      !payment_phone ||
      !payment_reference
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Todos los campos del formulario son obligatorios (Nombre y Apellido, Cédula, Teléfono, Correo, Teléfono de Pago y Referencia Bancaria).'
      });
    }

    if (!req.file && !req.body.screenshot_base64) {
      return res.status(400).json({
        ok: false,
        message: 'Debe adjuntar la captura de pantalla del pago.'
      });
    }

    if (![buyer_name, buyer_cedula, buyer_phone, buyer_email, payment_phone, payment_reference, session_id].every(v => typeof v === 'string' && v.trim().length > 0 && v.length <= 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer_email)) return res.status(400).json({ok:false, message:'Datos del comprador invalidos'});
    if (req.body.screenshot_base64 && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(req.body.screenshot_base64)) return res.status(400).json({ok:false, message:'Captura invalida'});
    const paddedTicket = String(ticket_number).padStart(3, '0');
    let screenshotPath = '';

    if (req.file) {
      screenshotPath = `/storage/uploads/${req.file.filename}`;
    } else if (req.body.screenshot_base64) {
      const filename = `pago-ticket-${paddedTicket}-${Date.now()}.png`;
      const base64Data = req.body.screenshot_base64.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(base64Data, 'base64'));
      screenshotPath = `/storage/uploads/${filename}`;
    }

    const config = getPublicConfig();

    const submitResult = submitOrderAtomic({
      ticket_number: paddedTicket,
      source_web: source_web || 'pagina-web-1',
      session_id,
      buyer_name: buyer_name.trim(),
      buyer_cedula: buyer_cedula.trim(),
      buyer_phone: buyer_phone.trim(),
      buyer_email: buyer_email.trim(),
      payment_phone: payment_phone.trim(),
      payment_reference: payment_reference.trim(),
      screenshot_path: screenshotPath,
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

    // Send confirmation of payment receipt via SMTP / Outbox
    await sendPaymentSubmittedEmail(submitResult.order);

    // Broadcast real-time update to both web pages and admin dashboard
    broadcastTicketsUpdate({
      name: 'admin:order_created',
      payload: submitResult.order
    });

    return res.status(201).json({
      ok: true,
      message: `¡Reporte de pago recibido para la Entrada #${paddedTicket}! En cuanto el administrador verifique tu pago, recibirás tu entrada PDF con código QR en ${submitResult.order.buyer_email}.`,
      order: submitResult.order
    });
  } catch (err) {
    console.error('Error submitting order:', err);
    return res.status(500).json({ ok: false, message: 'Error interno al procesar la compra.' });
  }
});

// ============================================================================
// ADMIN DASHBOARD API
// ============================================================================

app.get('/api/admin/overview', (_req, res) => {
  releaseExpiredLocks();
  const ticketsState = getAllTicketsPublic();
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
  const emailLogs = db.prepare('SELECT * FROM email_logs ORDER BY id DESC LIMIT 100').all();
  const campaigns = db.prepare('SELECT * FROM notification_campaigns ORDER BY id DESC LIMIT 50').all();
  const rawSettings = getAllSettings();
  delete rawSettings.secret_hmac_key;
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
 * Approve payment -> Marks ticket SOLD, generates unique Token & PDF with QR, sends email automatically
 */
app.post('/api/admin/orders/:id/approve', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { admin_notes } = req.body || {};

    const result = approveOrderAtomic(orderId, admin_notes);
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

    // Automatically email the buyer with the PDF ticket attached
    const emailResult = await sendTicketApprovedEmail(finalOrder, pdfFullPath, pdfRelativeUrl);

    broadcastTicketsUpdate({
      name: 'admin:order_updated',
      payload: finalOrder
    });

    return res.json({
      ok: true,
      message: `Pago aprobado. PDF generado. Estado del correo: ${emailResult.status}.`,
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
      message: `Pago rechazado. La entrada #${result.order.ticket_number} vuelve a estar disponible.`,
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
    const allowed = new Set(Object.keys(getAllSettings()).filter(k => k !== 'secret_hmac_key' && (!k.startsWith('bcv_') || ['bcv_mode', 'bcv_manual_rate'].includes(k))));
    if (Object.keys(updates).some(k => !allowed.has(k))) return res.status(400).json({ok:false, message:'Parametro no permitido'});
    for (const key of ['ticket_price_usd', 'bcv_manual_rate', 'lock_duration_seconds', 'smtp_port']) if (key in updates && (!Number.isFinite(Number(updates[key])) || Number(updates[key]) <= 0)) return res.status(400).json({ok:false, message:'Valor numerico invalido'});
    updateSettings(updates);
    broadcastConfigUpdate();
    return res.json({
      ok: true,
      message: 'Configuración actualizada y sincronizada en tiempo real con Página Web 1 y Página Web 2.',
      publicConfig: getPublicConfig(),
      settings: Object.fromEntries(Object.entries(getAllSettings()).filter(([key]) => key !== 'secret_hmac_key'))
    });
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
