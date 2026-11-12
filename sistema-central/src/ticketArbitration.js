const { createHash, randomUUID } = require('node:crypto');
const { db, getPublicConfig, recordTicketPayment } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS ticket_arbitration_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_number TEXT NOT NULL,
  order_id INTEGER,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

function audit(ticketNumber, orderId, actor, action, reason) {
  db.prepare(`INSERT INTO ticket_arbitration_log (ticket_number, order_id, actor, action, reason)
    VALUES (?, ?, ?, ?, ?)`).run(ticketNumber, orderId ?? null, actor, action, reason);
}

function getTicket(number) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE ticket_number = ?').get(number);
  if (!ticket) return null;
  const order = ticket.current_order_id == null ? null : db.prepare('SELECT * FROM orders WHERE id = ?').get(ticket.current_order_id);
  const revision = createHash('sha256').update(JSON.stringify([ticket, order])).digest('hex');
  const manualHold = ticket.status === 'LOCKED' && ticket.locked_by_session === null && ticket.locked_until === null;
  return { ticket, order, revision, manualHold };
}

function checkTicket(number, revision) {
  const current = getTicket(number);
  if (!current || current.revision !== revision || (current.ticket.locked_until != null && current.ticket.locked_until <= Date.now())) {
    return { ok: false, message: 'La entrada cambió desde que abriste el detalle. Vuelve a abrirla y revisa su estado.' };
  }
  return { ok: true, ...current };
}

function setAvailability(number, status) {
  db.prepare(`UPDATE tickets SET status = ?, locked_by_session = NULL, locked_by_source = NULL,
    locked_at = ?, locked_until = NULL, current_order_id = NULL,
    quoted_usd = NULL, quoted_rate = NULL, quoted_ves = NULL, updated_at = datetime('now')
    WHERE ticket_number = ?`).run(status, status === 'LOCKED' ? Date.now() : null, number);
}

function duplicatePayment(payment, orderId) {
  return db.prepare(`SELECT 1 FROM orders WHERE status IN ('PENDING', 'APPROVED')
    AND id != ? AND payment_reference = ? COLLATE NOCASE AND trim(payment_bank) = ? COLLATE NOCASE`).get(
    orderId ?? 0, payment.payment_reference, payment.payment_bank
  );
}

function applyAction(number, { revision, action, reason, actor, payment, source, screenshot, pdfPath }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = checkTicket(number, revision);
    if (!current.ok) return current;
    const { ticket, order, manualHold } = current;
    let affected = order;
    if (action === 'hold' && ticket.status === 'AVAILABLE') {
      setAvailability(number, 'LOCKED');
    } else if (action === 'release' && ticket.status === 'LOCKED') {
      setAvailability(number, 'AVAILABLE');
    } else if (action === 'cancel' && order && ['PENDING', 'SOLD'].includes(ticket.status)) {
      if (order.checked_in_at || order.checked_in_conference || order.checked_in_concert) {
        return { ok: false, message: 'Esta entrada ya tiene asistencia registrada y no se puede anular.' };
      }
      db.prepare("UPDATE orders SET status = 'CANCELLED', admin_notes = ? WHERE id = ?").run(reason, order.id);
      setAvailability(number, 'AVAILABLE');
    } else if (action === 'assist' && (ticket.status === 'AVAILABLE' || manualHold)) {
      if (duplicatePayment(payment)) return { ok: false, message: 'Ya hay un pago activo con ese banco y referencia. Revísalo en Pagos y ventas.' };
      const config = getPublicConfig();
      affected = recordTicketPayment({ ticket_number: number, locked_by_source: source }, {
        ...payment, session_id: `assisted-${randomUUID()}`, screenshot_path: screenshot,
        amount_usd: config.ticket_price_usd, bcv_rate: config.bcv_rate, amount_ves: config.ticket_price_ves
      });
    } else if (action === 'edit' && order && ['PENDING', 'SOLD'].includes(ticket.status)) {
      const changedPayment = payment.payment_bank !== order.payment_bank || payment.payment_reference !== order.payment_reference;
      if (changedPayment && duplicatePayment(payment, order.id)) {
        return { ok: false, message: 'Ya hay otro pago activo con ese banco y referencia.' };
      }
      db.prepare(`UPDATE orders SET buyer_name = ?, buyer_first_name = ?, buyer_last_name = ?, buyer_cedula = ?,
        buyer_phone = ?, buyer_email = ?, payment_phone = ?, payment_bank = ?, payment_reference = ?,
        buyer_comment = ?, screenshot_path = COALESCE(?, screenshot_path), pdf_path = COALESCE(?, pdf_path) WHERE id = ?`).run(
        payment.buyer_name, payment.buyer_first_name, payment.buyer_last_name, payment.buyer_cedula,
        payment.buyer_phone, payment.buyer_email, payment.payment_phone, payment.payment_bank,
        payment.payment_reference, payment.buyer_comment, screenshot, pdfPath, order.id
      );
      affected = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    } else {
      return { ok: false, message: 'La acción no está disponible para el estado actual de esta entrada.' };
    }
    audit(number, affected?.id, actor, action, reason);
    db.exec('COMMIT');
    return { ok: true, order: affected };
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
  }
}

module.exports = { getTicket, checkTicket, applyAction, audit };
