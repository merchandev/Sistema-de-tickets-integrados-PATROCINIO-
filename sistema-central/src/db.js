const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { calculateVes } = require('./money');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'entradas.sqlite');
const db = new DatabaseSync(dbPath);

// Configure WAL and concurrency settings for high performance & zero race conditions
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

// Create schema
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tickets (
    ticket_number TEXT PRIMARY KEY,
    numeric_id INTEGER UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'AVAILABLE', -- AVAILABLE, LOCKED, PENDING, SOLD
    locked_by_session TEXT,
    locked_by_source TEXT,
    locked_at INTEGER,
    locked_until INTEGER,
    current_order_id INTEGER,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_number TEXT NOT NULL,
    source_web TEXT NOT NULL,
    session_id TEXT NOT NULL,
    buyer_name TEXT NOT NULL,
    buyer_cedula TEXT NOT NULL,
    buyer_phone TEXT NOT NULL,
    buyer_email TEXT NOT NULL,
    payment_phone TEXT NOT NULL,
    payment_reference TEXT NOT NULL,
    screenshot_path TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    bcv_rate REAL NOT NULL,
    amount_ves REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED
    verification_token TEXT UNIQUE,
    pdf_path TEXT,
    checked_in_conference INTEGER DEFAULT 0,
    checked_in_conference_at TEXT,
    checked_in_concert INTEGER DEFAULT 0,
    checked_in_concert_at TEXT,
    checked_in_at TEXT,
    admin_notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    verified_at TEXT
  );

  CREATE TABLE IF NOT EXISTS email_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_email TEXT NOT NULL,
    recipient_name TEXT,
    subject TEXT NOT NULL,
    type TEXT NOT NULL,
    order_id INTEGER,
    ticket_number TEXT,
    status TEXT NOT NULL,
    preview_url TEXT,
    body_html TEXT,
    attachment_path TEXT,
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notification_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_key TEXT NOT NULL,
    triggered_by TEXT NOT NULL,
    recipients_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Backward-compatible migration: freeze the quote during the reservation.
for (const column of ['quoted_usd', 'quoted_rate', 'quoted_ves']) {
  if (!db.prepare('PRAGMA table_info(tickets)').all().some(c => c.name === column)) db.exec('ALTER TABLE tickets ADD COLUMN ' + column + ' REAL');
}
// Backward-compatible migration: separate first/last name, the paying bank and standalone payment
// reports (report_kind = 'REPORT', ticket_number = '' until an administrator assigns one).
for (const [column, type] of [
  ['buyer_first_name', 'TEXT'],
  ['buyer_last_name', 'TEXT'],
  ['payment_bank', 'TEXT'],
  ['report_kind', "TEXT NOT NULL DEFAULT 'CHECKOUT'"],
  ['requested_ticket', 'TEXT'],
  ['buyer_comment', 'TEXT'],
  ['checked_in_at', 'TEXT']
]) {
  if (!db.prepare('PRAGMA table_info(orders)').all().some(c => c.name === column)) db.exec(`ALTER TABLE orders ADD COLUMN ${column} ${type}`);
}

// Pago Móvil account of the event, shown in the checkout popup.
const EVENT_PAYMENT_METHODS = JSON.stringify({
  pago_movil: {
    banco: 'Bancamiga (0172)',
    telefono: '0412-2905205',
    rif_cedula: '28298508'
  }
});
const fullEventCondition = '2. Una sola entrada da acceso a todo el evento, incluidas las conferencias (4:00 PM a 7:00 PM) y el concierto (a partir de las 7:00 PM).';

// Seed default settings if not present
const defaultSettings = {
  event_title: 'Encuentro por una causa: conferencias y concierto benéfico',
  event_subtitle: 'Evento especial de recaudación para labor social',
  event_date: '2026-11-15',
  event_entry_time: '15:00',
  conference_start: '16:00',
  conference_end: '19:00',
  concert_start: '19:00',
  concert_end: 'Por definir (Abierto)',
  event_location: 'Auditorio Principal - Centro Cultural',
  ticket_price_usd: '5.00',
  lock_duration_seconds: '900',
  bcv_mode: 'auto', // 'auto' or 'manual'
  bcv_manual_rate: '45.50',
  bcv_last_scraped_rate: '45.50',
  bcv_last_updated: new Date().toISOString(),
  bcv_source_label: 'Banco Central de Venezuela (BCV)',
  bcv_source_url: '',
  bcv_value_date: '',
  bcv_fetch_status: 'unavailable',
  bcv_last_error: '',
  payment_methods_json: EVENT_PAYMENT_METHODS,
  event_schedule_json: JSON.stringify([
    {
      time: '3:00 PM - 4:00 PM',
      phase: 'Ingreso y acreditación',
      title: 'Acceso y registro con QR',
      description: 'Recepción de asistentes y validación del código QR único de cada entrada.'
    },
    {
      time: '4:00 PM - 7:00 PM',
      phase: 'Ciclo de conferencias',
      title: 'Conferencias con propósito social',
      description: 'Bloque completo de ponencias e invitados especiales. Comienza a las 4:00 PM y culmina a las 7:00 PM.'
    },
    {
      time: '7:00 PM en adelante',
      phase: 'Concierto en vivo',
      title: 'Gran concierto benéfico',
      description: 'Inicia a partir de las 7:00 PM (hora de finalización abierta). Una sola entrada incluye las conferencias y el concierto.'
    }
  ]),
  event_conditions: [
    '1. La entrada tiene un valor único de $5.00 USD (calculados en bolívares a la tasa oficial del BCV en tiempo real al momento del pago).',
    fullEventCondition,
    '3. Es obligatorio presentar el PDF de la entrada con su código QR único y su cédula de identidad laminada al ingresar.',
    '4. Los datos suministrados en el pago (nombre, apellido, cédula, teléfono y referencia) son verificados por la administración para garantizar que quien realizó el pago sea quien reciba la entrada.'
  ].join('\n'),
  terms_and_conditions: [
    '1. Reserva temporal de 15 minutos: el sistema asigna la primera entrada disponible por orden de solicitud y la reserva durante quince (15) minutos.',
    '2. Si vence el plazo, cancelas la reserva o sales de la página antes de reportar el pago, la entrada se libera. Si el navegador pierde la conexión al salir, se libera al vencer el plazo.',
    '3. Verificación administrativa: una vez enviado el formulario con la captura y referencia bancaria, la entrada pasa a estado "En verificación" hasta que un administrador valide la transacción en el panel de administración.',
    '4. Envío automático: al aprobarse el pago, el sistema genera un PDF con un token y un código QR criptográfico únicos y lo envía automáticamente al correo electrónico registrado.'
  ].join('\n'),
  smtp_host: process.env.SMTP_HOST || '',
  smtp_port: process.env.SMTP_PORT || '587',
  smtp_secure: process.env.SMTP_SECURE || 'false',
  smtp_user: process.env.SMTP_USER || '',
  smtp_pass: process.env.SMTP_PASS || '',
  smtp_from: process.env.SMTP_FROM || 'Entradas Labor Social <entradas@laborsocial.org>',
  // Optional IMAP account: a copy of every message sent by SMTP is saved in its "Sent" folder.
  imap_host: process.env.IMAP_HOST || '',
  imap_port: process.env.IMAP_PORT || '993',
  imap_user: process.env.IMAP_USER || '',
  imap_pass: process.env.IMAP_PASS || '',
  imap_sent_folder: process.env.IMAP_SENT_FOLDER || '',
  // Payment control sheet in Google Sheets (see src/googleSheets.js); the web app URL and key are set
  // by the superadmin from the panel once the sheet's script is installed.
  sheets_sheet_url: 'https://docs.google.com/spreadsheets/d/1-QwaXmGvrgs3RopcTrPnPhtp62gFX9J21NVxKSQLy6I/edit',
  sheets_webapp_url: '',
  sheets_secret: '',
  sheets_last_status: '',
  secret_hmac_key: crypto.randomBytes(32).toString('hex')
};

const insertSettingStmt = db.prepare(`
  INSERT OR IGNORE INTO settings (key, value, updated_at)
  VALUES (?, ?, datetime('now'))
`);

db.exec('BEGIN IMMEDIATE TRANSACTION');
try {
  // Preserve the first recorded arrival for tickets scanned before attendance was unified.
  db.exec(`
    UPDATE orders
    SET checked_in_at = COALESCE(
      MIN(checked_in_conference_at, checked_in_concert_at),
      checked_in_conference_at,
      checked_in_concert_at
    )
    WHERE checked_in_at IS NULL
      AND (checked_in_conference_at IS NOT NULL OR checked_in_concert_at IS NOT NULL)
  `);
  for (const [k, v] of Object.entries(defaultSettings)) {
    insertSettingStmt.run(k, String(v));
  }

  // Update the old default wording without replacing schedules or conditions edited in the panel.
  const replaceSettingText = db.prepare(`
    UPDATE settings SET value = replace(value, ?, ?), updated_at = datetime('now')
    WHERE key = ? AND instr(value, ?) > 0
  `);
  const legacyCondition = '2. Todas las personas que adquieran su entrada tienen acceso completo a las dos partes del evento: las Conferencias (4:00 PM a 7:00 PM) y el Concierto (a partir de las 7:00 PM).';
  replaceSettingText.run(legacyCondition, fullEventCondition, 'event_conditions', legacyCondition);
  for (const [before, after] of [
    ['Parte 1: Ciclo de Conferencias', 'Ciclo de Conferencias'],
    ['Parte 2: Concierto en Vivo', 'Concierto en Vivo'],
    ['Todas las entradas incluyen acceso a ambas partes del evento.', 'Una sola entrada incluye las conferencias y el concierto.']
  ]) {
    replaceSettingText.run(before, after, 'event_schedule_json', before);
  }
  // Spanish sentence case for the default wording (headings and labels only capitalize the first word)
  for (const [key, before, after] of [
    ['event_schedule_json', '"Ingreso y Acreditación"', '"Ingreso y acreditación"'],
    ['event_schedule_json', '"Apertura de Puertas y Escaneo de QR"', '"Acceso y registro con QR"'],
    ['event_schedule_json', '"Apertura de puertas y escaneo del QR"', '"Acceso y registro con QR"'],
    ['event_schedule_json', '"Apertura de puertas y validación del QR"', '"Acceso y registro con QR"'],
    ['event_schedule_json', '"Ciclo de Conferencias"', '"Ciclo de conferencias"'],
    ['event_schedule_json', '"Conferencias con Propósito Social"', '"Conferencias con propósito social"'],
    ['event_schedule_json', '"Concierto en Vivo"', '"Concierto en vivo"'],
    ['event_schedule_json', '"Gran Concierto Benéfico"', '"Gran concierto benéfico"'],
    ['event_conditions', 'calculados en Bolívares', 'calculados en bolívares'],
    ['event_conditions', 'su Cédula de Identidad laminada', 'su cédula de identidad laminada'],
    ['event_conditions', '(Nombre, Apellido, Cédula, Teléfono y Referencia)', '(nombre, apellido, cédula, teléfono y referencia)'],
    ['terms_and_conditions', 'Reserva temporal de 3 minutos: Al seleccionar', 'Reserva temporal de 3 minutos: al seleccionar'],
    ['terms_and_conditions', 'Verificación administrativa: Una vez', 'Verificación administrativa: una vez'],
    ['terms_and_conditions', 'estado "En Verificación"', 'estado "En verificación"'],
    ['terms_and_conditions', 'valide la transacción en el Dashboard.', 'valide la transacción en el panel de administración.'],
    ['terms_and_conditions', 'Envío automático: Al aprobarse', 'Envío automático: al aprobarse'],
    ['terms_and_conditions', 'un PDF con un Token y Código QR criptográfico único', 'un PDF con un token y un código QR criptográfico únicos'],
    ['event_title', 'Conferencias & Concierto Benéfico', 'Conferencias y concierto benéfico'],
    ['event_title', 'Encuentro por una Causa: Conferencias y concierto benéfico', 'Encuentro por una causa: conferencias y concierto benéfico'],
    ['event_subtitle', 'para Labor Social (Entradas 001 - 250)', 'para labor social (entradas 001 - 250)']
  ]) {
    replaceSettingText.run(before, after, key, before);
  }
  // Doors open at 3:00 PM (the first default said 3:30 PM)
  db.prepare("UPDATE settings SET value = '15:00', updated_at = datetime('now') WHERE key = 'event_entry_time' AND value = '15:30'").run();
  for (const before of ['3:30 PM - 4:00 PM', '3:30 PM – 4:00 PM']) {
    replaceSettingText.run(before, before.replace('3:30', '3:00'), 'event_schedule_json', before);
  }
  const formerReservationTerm = 'al seleccionar una entrada (001 al 250), el sistema bloquea automáticamente el puesto por tres (3) minutos dándole prioridad exclusiva a la primera persona que lo seleccionó.';
  replaceSettingText.run(formerReservationTerm, 'el sistema asigna la primera entrada disponible por orden de solicitud y la reserva durante tres (3) minutos.', 'terms_and_conditions', formerReservationTerm);
  db.prepare("UPDATE settings SET value = '900', updated_at = datetime('now') WHERE key = 'lock_duration_seconds' AND value IN ('180', '360')").run();
  for (const [before, after] of [
    ['Reserva temporal de 3 minutos', 'Reserva temporal de 15 minutos'],
    ['durante tres (3) minutos.', 'durante quince (15) minutos.'],
    ['Reserva temporal de 6 minutos', 'Reserva temporal de 15 minutos'],
    ['durante seis (6) minutos.', 'durante quince (15) minutos.'],
    ['Si transcurren los 3 minutos o se cierra la sesión sin enviar el soporte de pago, la entrada vuelve a estar disponible automáticamente para todas las páginas conectadas.', 'Si vence el plazo, cancelas la reserva o sales de la página antes de reportar el pago, la entrada se libera. Si el navegador pierde la conexión al salir, se libera al vencer el plazo.']
  ]) replaceSettingText.run(before, after, 'terms_and_conditions', before);
  replaceSettingText.run(' (entradas 001 - 250)', '', 'event_subtitle', ' (entradas 001 - 250)');

  // Seed tickets 001 to 250
  const insertTicketStmt = db.prepare(`
    INSERT OR IGNORE INTO tickets (ticket_number, numeric_id, status)
    VALUES (?, ?, 'AVAILABLE')
  `);
  for (let i = 1; i <= 250; i++) {
    const code = String(i).padStart(3, '0');
    insertTicketStmt.run(code, i);
  }
  // Installations created before the real account still carry the placeholder bank details.
  db.prepare(`
    UPDATE settings SET value = ?, updated_at = datetime('now')
    WHERE key = 'payment_methods_json' AND value LIKE '%0412-0000000%'
  `).run(EVENT_PAYMENT_METHODS);
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

// Helper functions
function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const r of rows) {
    map[r.key] = r.value;
  }
  return map;
}

function getPublicConfig() {
  const s = getAllSettings();
  const effectiveRate = s.bcv_mode === 'manual'
    ? parseFloat(s.bcv_manual_rate || '45.50')
    : parseFloat(s.bcv_last_scraped_rate || s.bcv_manual_rate || '45.50');
  const priceUsd = parseFloat(s.ticket_price_usd || '5.00');
  const priceVes = calculateVes(priceUsd, effectiveRate);

  let paymentMethods = {};
  let schedule = [];
  try { paymentMethods = JSON.parse(s.payment_methods_json || '{}'); } catch (_) {}
  try { schedule = JSON.parse(s.event_schedule_json || '[]'); } catch (_) {}

  return {
    sales_enabled: process.env.SALES_ENABLED !== 'false',
    event_title: s.event_title,
    event_subtitle: s.event_subtitle,
    event_date: s.event_date,
    event_entry_time: s.event_entry_time,
    conference_start: s.conference_start,
    conference_end: s.conference_end,
    concert_start: s.concert_start,
    concert_end: s.concert_end,
    event_location: s.event_location,
    ticket_price_usd: priceUsd,
    bcv_rate: effectiveRate,
    bcv_mode: s.bcv_mode,
    bcv_last_updated: s.bcv_last_updated,
    bcv_source_label: s.bcv_source_label,
    bcv_source_url: s.bcv_source_url,
    bcv_value_date: s.bcv_value_date,
    bcv_fetch_status: s.bcv_fetch_status,
    bcv_last_error: s.bcv_last_error,
    bcv_is_official: s.bcv_source_url === 'https://www.bcv.org.ve/',
    ticket_price_ves: priceVes,
    lock_duration_seconds: parseInt(s.lock_duration_seconds || '900', 10),
    payment_methods: paymentMethods,
    event_schedule: schedule,
    event_conditions: s.event_conditions,
    terms_and_conditions: s.terms_and_conditions
  };
}

function updateSettings(updates) {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `);
  db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && v !== null) {
        const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
        upsert.run(k, valStr);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Releases LOCKED tickets whose reservation has expired.
 * Returns array of released ticket_numbers so Socket.IO can broadcast if any changed.
 */
function releaseExpiredLocks() {
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    const expired = db.prepare(`
      SELECT ticket_number, locked_by_session, locked_by_source
      FROM tickets
      WHERE status = 'LOCKED' AND locked_until IS NOT NULL AND locked_until <= ?
    `).all(now);

    if (expired.length > 0) {
      const releaseStmt = db.prepare(`
        UPDATE tickets
        SET status = 'AVAILABLE',
            locked_by_session = NULL,
            locked_by_source = NULL,
            locked_at = NULL,
            locked_until = NULL,
            updated_at = datetime('now')
        WHERE ticket_number = ? AND status = 'LOCKED'
      `);
      for (const row of expired) {
        releaseStmt.run(row.ticket_number);
      }
    }
    db.exec('COMMIT');
    return expired;
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('Error releasing expired locks:', err);
    return [];
  }
}

function nextAvailableTicket() {
  return db.prepare("SELECT ticket_number FROM tickets WHERE status = 'AVAILABLE' ORDER BY numeric_id LIMIT 1").get()?.ticket_number;
}

// Select and reserve within one transaction so requests from either site cannot share a number.
function lockTicketAtomic(ticketNumber, sessionId, sourceWeb) {
  const now = Date.now();
  const settings = getAllSettings();
  const lockDurationMs = parseInt(settings.lock_duration_seconds || '900', 10) * 1000;
  const lockedUntil = now + lockDurationMs;
  const quote = getPublicConfig();

  db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    // First expire any stale locks right inside the atomic transaction
    db.prepare(`
      UPDATE tickets
      SET status = 'AVAILABLE',
          locked_by_session = NULL,
          locked_by_source = NULL,
          locked_at = NULL,
          locked_until = NULL,
          updated_at = datetime('now')
      WHERE status = 'LOCKED' AND locked_until IS NOT NULL AND locked_until <= ?
    `).run(now);

    if (!ticketNumber) {
      // Repeated requests from the same tab keep the number and the original deadline.
      ticketNumber = db.prepare("SELECT ticket_number FROM tickets WHERE status = 'LOCKED' AND locked_by_session = ? ORDER BY numeric_id LIMIT 1").get(sessionId)?.ticket_number;
      if (!ticketNumber) ticketNumber = nextAvailableTicket();
      if (!ticketNumber) {
        db.exec('COMMIT');
        return { success: false, code: 'NO_AVAILABLE_TICKET', message: 'No pudimos asignar una entrada en este momento. Intenta más tarde.' };
      }
    }
    const ticket = db.prepare('SELECT * FROM tickets WHERE ticket_number = ?').get(ticketNumber);
    if (!ticket) {
      db.exec('ROLLBACK');
      return { success: false, code: 'NOT_FOUND', message: `La entrada ${ticketNumber} no existe (rango válido: 001 al 250).` };
    }

    // If this same session already holds another LOCKED ticket, release the previous one so a user locks 1 at a time
    const prevLocked = db.prepare(`
      SELECT ticket_number FROM tickets
      WHERE status = 'LOCKED' AND locked_by_session = ? AND ticket_number != ?
    `).all(sessionId, ticketNumber);

    for (const prev of prevLocked) {
      db.prepare(`
        UPDATE tickets
        SET status = 'AVAILABLE',
            locked_by_session = NULL,
            locked_by_source = NULL,
            locked_at = NULL,
            locked_until = NULL,
            updated_at = datetime('now')
        WHERE ticket_number = ?
      `).run(prev.ticket_number);
    }

    if (ticket.status === 'SOLD') {
      db.exec('ROLLBACK');
      return {
        success: false,
        code: 'ALREADY_SOLD',
        message: `La entrada #${ticketNumber} ya fue vendida.`
      };
    }

    if (ticket.status === 'PENDING') {
      db.exec('ROLLBACK');
      return {
        success: false,
        code: 'PENDING_VERIFICATION',
        message: `La entrada #${ticketNumber} ya tiene un pago en proceso de verificación.`
      };
    }

    if (ticket.status === 'LOCKED' && ticket.locked_by_session !== sessionId) {
      const remainingSec = Math.max(1, Math.ceil((ticket.locked_until - now) / 1000));
      db.exec('ROLLBACK');
      return {
        success: false,
        code: 'LOCKED_BY_OTHER',
        remainingSeconds: remainingSec,
        lockedBySource: ticket.locked_by_source,
        message: `La entrada #${ticketNumber} acaba de ser seleccionada por otro usuario (${ticket.locked_by_source}). Estará bloqueada por ${remainingSec} segundos.`
      };
    }

    // Either AVAILABLE or already LOCKED by this exact same session
    const effectiveLockedUntil = ticket.status === 'LOCKED' && ticket.locked_by_session === sessionId
      ? ticket.locked_until
      : lockedUntil;

    db.prepare(`
      UPDATE tickets
      SET status = 'LOCKED',
          locked_by_session = ?,
          locked_by_source = ?,
          locked_at = COALESCE(locked_at, ?),
          locked_until = ?,
          updated_at = datetime('now')
      WHERE ticket_number = ?
    `).run(sessionId, ticket.status === 'LOCKED' ? ticket.locked_by_source : sourceWeb, now, effectiveLockedUntil, ticketNumber);

    if (ticket.status !== 'LOCKED') db.prepare('UPDATE tickets SET quoted_usd = ?, quoted_rate = ?, quoted_ves = ? WHERE ticket_number = ?').run(quote.ticket_price_usd, quote.bcv_rate, quote.ticket_price_ves, ticketNumber);
    const updatedTicket = db.prepare('SELECT * FROM tickets WHERE ticket_number = ?').get(ticketNumber);
    db.exec('COMMIT');

    return {
      success: true,
      ticket: updatedTicket,
      releasedPrevious: prevLocked.map(p => p.ticket_number),
      serverTime: now
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Releases a lock voluntarily (e.g. user cancels or closes session/modal)
 */
function unlockTicketAtomic(ticketNumber, sessionId) {
  const result = db.prepare(`
        UPDATE tickets
        SET status = 'AVAILABLE',
            locked_by_session = NULL,
            locked_by_source = NULL,
            locked_at = NULL,
            locked_until = NULL,
            updated_at = datetime('now')
        WHERE status = 'LOCKED' AND locked_by_session = ?
          AND (? IS NULL OR ticket_number = ?)
      `).run(sessionId, ticketNumber, ticketNumber);
  return { success: true, released: result.changes > 0, ticketNumber };
}

/**
 * Submits payment proof for a locked ticket.
 * Atomically verifies the user holds the lock (or ticket is still available) and moves ticket to PENDING.
 */
function submitOrderAtomic(orderData) {
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    // Expire stale locks first
    db.prepare(`
      UPDATE tickets
      SET status = 'AVAILABLE',
          locked_by_session = NULL,
          locked_by_source = NULL,
          locked_at = NULL,
          locked_until = NULL,
          updated_at = datetime('now')
      WHERE status = 'LOCKED' AND locked_until IS NOT NULL AND locked_until <= ?
    `).run(now);

    const ticket = db.prepare('SELECT * FROM tickets WHERE ticket_number = ?').get(orderData.ticket_number);
    if (!ticket || ticket.status !== 'LOCKED' || ticket.locked_by_session !== orderData.session_id) {
      db.exec('ROLLBACK');
      return {
        success: false,
        code: 'LOCKED_BY_OTHER',
        message: 'La reserva de esta entrada ya no está vigente.'
      };
    }

    const order = recordTicketPayment(ticket, orderData);
    db.exec('COMMIT');
    return { success: true, order };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// The caller owns the transaction and has checked that this ticket can receive a payment.
function recordTicketPayment(ticket, orderData) {
  const insertResult = db.prepare(`
    INSERT INTO orders (
      ticket_number, source_web, session_id,
      buyer_name, buyer_first_name, buyer_last_name, buyer_cedula, buyer_phone, buyer_email,
      payment_phone, payment_reference, payment_bank, screenshot_path,
      amount_usd, bcv_rate, amount_ves, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
  `).run(
    ticket.ticket_number,
    ticket.locked_by_source,
    orderData.session_id,
    orderData.buyer_name,
    orderData.buyer_first_name || null,
    orderData.buyer_last_name || null,
    orderData.buyer_cedula,
    orderData.buyer_phone,
    orderData.buyer_email,
    orderData.payment_phone,
    orderData.payment_reference,
    orderData.payment_bank || null,
    orderData.screenshot_path,
    ticket.quoted_usd ?? orderData.amount_usd,
    ticket.quoted_rate ?? orderData.bcv_rate,
    ticket.quoted_ves ?? orderData.amount_ves
  );

  const orderId = Number(insertResult.lastInsertRowid);

  // Transition ticket to PENDING
  db.prepare(`
    UPDATE tickets
    SET status = 'PENDING',
        locked_by_session = ?,
        locked_by_source = ?,
        locked_until = NULL,
        current_order_id = ?,
        updated_at = datetime('now')
    WHERE ticket_number = ?
  `).run(orderData.session_id, ticket.locked_by_source, orderId, ticket.ticket_number);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

/**
 * Records a payment reported outside the checkout popup (for example after the reservation expired).
 * It does not hold any ticket: an administrator assigns an available one when approving it.
 */
function submitPaymentReport(report) {
  const result = db.prepare(`
    INSERT INTO orders (
      ticket_number, source_web, session_id,
      buyer_name, buyer_first_name, buyer_last_name, buyer_cedula, buyer_phone, buyer_email,
      payment_phone, payment_reference, payment_bank, screenshot_path,
      amount_usd, bcv_rate, amount_ves, status, report_kind, requested_ticket, buyer_comment
    ) VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'REPORT', ?, ?)
  `).run(
    report.source_web,
    report.session_id,
    report.buyer_name,
    report.buyer_first_name,
    report.buyer_last_name,
    report.buyer_cedula,
    report.buyer_phone,
    report.buyer_email,
    report.payment_phone,
    report.payment_reference,
    report.payment_bank,
    report.screenshot_path,
    report.amount_usd,
    report.bcv_rate,
    report.amount_ves,
    report.requested_ticket || null,
    report.buyer_comment || null
  );
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(result.lastInsertRowid));
}

/**
 * Generates a unique cryptographic token for a verified ticket and marks the order APPROVED & ticket SOLD.
 * Standalone payment reports receive the lowest available number.
 */
function approveOrderAtomic(orderId, adminNotes = '', assignTicket = null, onApproved) {
  db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) {
      db.exec('ROLLBACK');
      return { success: false, message: 'Orden no encontrada.' };
    }
    if (!order.ticket_number) {
      if (order.status !== 'PENDING') {
        db.exec('ROLLBACK');
        return { success: false, message: 'Este reporte de pago ya fue procesado.' };
      }
      db.prepare(`
        UPDATE tickets
        SET status = 'AVAILABLE', locked_by_session = NULL, locked_by_source = NULL, locked_at = NULL, locked_until = NULL, updated_at = datetime('now')
        WHERE status = 'LOCKED' AND locked_until IS NOT NULL AND locked_until <= ?
      `).run(Date.now());
      const nextTicket = nextAvailableTicket();
      if (!nextTicket) {
        db.exec('ROLLBACK');
        return { success: false, message: 'No hay una entrada libre para asignar a este pago.' };
      }
      if (assignTicket && assignTicket !== nextTicket) {
        db.exec('ROLLBACK');
        return { success: false, message: `La primera entrada libre es la #${nextTicket}. Aprueba el pago con ese número o deja que se asigne automáticamente.` };
      }
      db.prepare('UPDATE orders SET ticket_number = ? WHERE id = ?').run(nextTicket, orderId);
      db.prepare('UPDATE tickets SET locked_by_source = ? WHERE ticket_number = ?').run(order.source_web, nextTicket);
      order.ticket_number = nextTicket;
    } else if (order.status !== 'PENDING' || !db.prepare("SELECT 1 FROM tickets WHERE ticket_number = ? AND status = 'PENDING' AND current_order_id = ?").get(order.ticket_number, orderId)) {
      db.exec('ROLLBACK');
      return { success: false, message: 'Esta orden ya fue aprobada anteriormente.' };
    }

    const secret = db.prepare("SELECT value FROM settings WHERE key = 'secret_hmac_key'").get()?.value || 'default_secret';
    const rawUuid = crypto.randomUUID().toUpperCase();
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${order.ticket_number}:${order.id}:${order.buyer_cedula}:${rawUuid}`)
      .digest('hex')
      .slice(0, 12)
      .toUpperCase();

    const verificationToken = `Espressivo-${order.ticket_number}-${rawUuid.split('-')[0]}-${signature}`;

    db.prepare(`
      UPDATE orders
      SET status = 'APPROVED',
          verification_token = ?,
          admin_notes = ?,
          verified_at = datetime('now')
      WHERE id = ?
    `).run(verificationToken, adminNotes || 'Pago verificado correctamente', orderId);

    db.prepare(`
      UPDATE tickets
      SET status = 'SOLD',
          locked_until = NULL,
          current_order_id = ?,
          updated_at = datetime('now')
      WHERE ticket_number = ?
    `).run(orderId, order.ticket_number);

    const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    onApproved?.(updatedOrder);
    db.exec('COMMIT');

    return {
      success: true,
      order: updatedOrder
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Rejects a payment order and releases the ticket back to AVAILABLE.
 */
function rejectOrderAtomic(orderId, reason = 'Pago no verificado o datos inconsistentes') {
  db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) {
      db.exec('ROLLBACK');
      return { success: false, message: 'Orden no encontrada.' };
    }
    const holdsTicket = Boolean(order.ticket_number);
    if (order.status !== 'PENDING' || (holdsTicket && !db.prepare("SELECT 1 FROM tickets WHERE ticket_number = ? AND status = 'PENDING' AND current_order_id = ?").get(order.ticket_number, orderId))) {
      db.exec('ROLLBACK');
      return { success: false, message: 'Esta orden ya fue procesada.' };
    }

    db.prepare(`
      UPDATE orders
      SET status = 'REJECTED',
          admin_notes = ?,
          verified_at = datetime('now')
      WHERE id = ?
    `).run(reason, orderId);

    // Release ticket if it was pointing to this order
    db.prepare(`
      UPDATE tickets
      SET status = 'AVAILABLE',
          locked_by_session = NULL,
          locked_by_source = NULL,
          locked_at = NULL,
          locked_until = NULL,
          current_order_id = NULL,
          updated_at = datetime('now')
      WHERE ticket_number = ? AND (current_order_id = ? OR status != 'SOLD')
    `).run(order.ticket_number, orderId);

    const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    db.exec('COMMIT');

    return {
      success: true,
      order: updatedOrder
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getReservationState(sessionId) {
  const serverTime = Date.now();
  const row = typeof sessionId === 'string' && sessionId.length >= 8 && sessionId.length <= 254
    ? db.prepare(`SELECT ticket_number, locked_until, quoted_usd, quoted_rate, quoted_ves
        FROM tickets WHERE status = 'LOCKED' AND locked_by_session = ? AND locked_until > ?
        ORDER BY numeric_id LIMIT 1`).get(sessionId, serverTime)
    : null;
  const reservation = row ? {
    ticket_number: row.ticket_number,
    locked_until: row.locked_until,
    pricing: { amount_usd: row.quoted_usd, bcv_rate: row.quoted_rate, amount_ves: row.quoted_ves }
  } : null;
  return { serverTime, reservation };
}

function getAllTicketsForAdmin() {
  releaseExpiredLocks();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT ticket_number, numeric_id, status, locked_by_source, locked_until, current_order_id
    FROM tickets
    ORDER BY numeric_id ASC
  `).all();

  return {
    serverTime: now,
    tickets: rows.map(r => ({
      ticket_number: r.ticket_number,
      numeric_id: r.numeric_id,
      status: r.status,
      locked_by_source: r.locked_by_source,
      current_order_id: r.current_order_id,
      locked_until: r.status === 'LOCKED' ? r.locked_until : null,
      remaining_seconds: r.status === 'LOCKED' && r.locked_until
        ? Math.max(0, Math.ceil((r.locked_until - now) / 1000))
        : 0
    }))
  };
}

module.exports = {
  db,
  getAllSettings,
  getPublicConfig,
  updateSettings,
  releaseExpiredLocks,
  lockTicketAtomic,
  unlockTicketAtomic,
  submitOrderAtomic,
  recordTicketPayment,
  submitPaymentReport,
  approveOrderAtomic,
  rejectOrderAtomic,
  getReservationState,
  getAllTicketsForAdmin
};
