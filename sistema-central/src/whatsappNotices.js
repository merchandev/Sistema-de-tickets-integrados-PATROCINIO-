// Event notices by WhatsApp, sent by the team from their own phone: WhatsApp does not let a system send
// bulk messages without the Business API, so the panel prepares one message per registered number
// (names, tickets and a link to each ticket's PDF) and opens the chat ready to send. Which numbers
// already got each notice is shared by the whole team, so nobody sends it twice.
const crypto = require('node:crypto');
const { db, getAllSettings, getPublicConfig } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_notices (
  notice TEXT NOT NULL,
  phone TEXT NOT NULL,
  sent_by TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (notice, phone)
)`);

const NOTICES = {
  REMINDER_TODAY: 'Hoy es el evento',
  REMINDER_REGISTRATION: 'Registro a las 3:00 PM',
  EVENT_STARTED: 'Ya comenzamos'
};

// "0414-123.45.67" -> "584141234567"; numbers with a country code keep it.
function whatsappNumber(value) {
  const raw = String(value || '').trim();
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') || digits.startsWith('58')) return digits.length >= 10 && digits.length <= 15 ? digits : null;
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits.length === 10 ? `58${digits}` : null;
}

// Signed public link to one ticket's PDF (see /verify/entrada in server.js)
function ticketPdfSignature(order) {
  const key = getAllSettings().secret_hmac_key || 'entradas';
  return crypto.createHmac('sha256', key).update(`pdf:${order.id}:${order.verification_token}`).digest('base64url').slice(0, 32);
}
const ticketPdfLink = (baseUrl, order) => `${baseUrl}/verify/entrada/${order.id}/${ticketPdfSignature(order)}.pdf`;

const twelveHour = (time) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  return m ? `${Number(m[1]) % 12 || 12}:${m[2]} ${Number(m[1]) >= 12 ? 'PM' : 'AM'}` : time || '';
};
const joinNames = (names) => names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names.at(-1)}` : names[0];

// "Las conferencias comienzan a las 4:00 PM y el concierto arranca a las 7:00 PM."
const scheduleLine = (cfg) => `Las conferencias comienzan a las ${twelveHour(cfg.conference_start || '16:00')} y el concierto arranca a las ${twelveHour(cfg.concert_start || '19:00')}.`;

function noticeText(notice, group, baseUrl, cfg = getPublicConfig()) {
  const names = joinNames([...new Set(group.orders.map(o => o.buyer_first_name || String(o.buyer_name || '').split(' ')[0]))]);
  const tickets = group.orders.map(o => `#${o.ticket_number}`);
  const ticketsText = tickets.length > 1 ? `tus entradas ${joinNames(tickets)}` : `tu entrada ${tickets[0]}`;
  const entry = twelveHour(cfg.event_entry_time || '15:00');
  // The saved location may end with a period: the sentence adds its own punctuation
  const place = String(cfg.event_location || '').trim().replace(/[.\s]+$/, '');
  const opening = {
    REMINDER_TODAY: `¡Hoy es el evento! Hola ${names}, te esperamos hoy en ${place} para ${cfg.event_title}. El acceso y registro comienzan a las ${entry}.`,
    REMINDER_REGISTRATION: `Hola ${names}, te recordamos que hoy a las ${entry} abre el registro de ${cfg.event_title} en ${place}. Llega con tiempo para entrar sin filas.`,
    EVENT_STARTED: `¡Ya comenzamos! Hola ${names}, las puertas de ${cfg.event_title} ya están abiertas en ${place}.`
  }[notice];
  const links = group.orders.map(o => (group.orders.length > 1 ? `#${o.ticket_number}: ` : '') + ticketPdfLink(baseUrl, o)).join('\n');
  return [opening, scheduleLine(cfg), `Muestra el código QR de ${ticketsText} y tu cédula en el acceso.`, `Si no tienes tu entrada a mano, descárgala aquí:\n${links}`].join('\n\n');
}

// Approved tickets grouped by WhatsApp number, with whether this notice was already sent to it.
function recipients(notice, baseUrl) {
  const sent = new Map(db.prepare('SELECT phone, sent_by, sent_at FROM whatsapp_notices WHERE notice = ?').all(notice).map(r => [r.phone, r]));
  const groups = new Map();
  for (const order of db.prepare(`SELECT o.* FROM orders o JOIN tickets t ON t.current_order_id = o.id AND t.status = 'SOLD'
    WHERE o.status = 'APPROVED' AND o.verification_token IS NOT NULL ORDER BY o.ticket_number`).all()) {
    const phone = whatsappNumber(order.buyer_phone);
    if (!phone) continue;
    if (!groups.has(phone)) groups.set(phone, { phone, orders: [] });
    groups.get(phone).orders.push(order);
  }
  const cfg = getPublicConfig();
  return [...groups.values()].map(group => ({
    phone: group.phone,
    display: group.phone.startsWith('58') ? `0${group.phone.slice(2, 5)}-${group.phone.slice(5)}` : `+${group.phone}`,
    names: [...new Set(group.orders.map(o => o.buyer_name))],
    tickets: group.orders.map(o => o.ticket_number),
    sentBy: sent.get(group.phone)?.sent_by || null,
    sentAt: sent.get(group.phone)?.sent_at || null,
    url: `https://wa.me/${group.phone}?text=${encodeURIComponent(noticeText(notice, group, baseUrl, cfg))}`
  }));
}

// vCard with every buyer's number, to save them in a phone and build WhatsApp broadcast lists.
function contactsVcf() {
  const groups = new Map();
  for (const o of db.prepare(`SELECT ticket_number, buyer_name, buyer_phone FROM orders WHERE status = 'APPROVED' ORDER BY ticket_number`).all()) {
    const phone = whatsappNumber(o.buyer_phone);
    if (!phone) continue;
    if (!groups.has(phone)) groups.set(phone, []);
    groups.get(phone).push(o);
  }
  const esc = (v) => String(v || '').replace(/[\\,;]/g, m => `\\${m}`).replace(/\r?\n/g, ' ');
  return [...groups.entries()].map(([phone, orders]) => [
    'BEGIN:VCARD', 'VERSION:3.0',
    `FN:${esc(`Entrada ${orders.map(o => o.ticket_number).join('-')} ${orders[0].buyer_name}`)}`,
    `TEL;TYPE=CELL:+${phone}`,
    `NOTE:${esc(`Entradas ${orders.map(o => '#' + o.ticket_number).join(', ')}`)}`,
    'END:VCARD'
  ].join('\r\n')).join('\r\n') + '\r\n';
}

function registerWhatsappNoticeRoutes(app, { baseUrl }) {
  const validNotice = (key) => Object.hasOwn(NOTICES, key);

  app.get('/api/admin/whatsapp/notices/:notice', (req, res) => {
    if (!validNotice(req.params.notice)) return res.status(404).json({ ok: false, message: 'Aviso desconocido.' });
    const list = recipients(req.params.notice, baseUrl);
    return res.json({ ok: true, notice: req.params.notice, label: NOTICES[req.params.notice], total: list.length, sent: list.filter(r => r.sentAt).length, recipients: list });
  });

  // Marks (or unmarks) a number as having received the notice
  app.post('/api/admin/whatsapp/notices/:notice/mark', (req, res) => {
    const phone = whatsappNumber(req.body?.phone);
    if (!validNotice(req.params.notice) || !phone) return res.status(400).json({ ok: false, message: 'Aviso o número no válido.' });
    if (req.body?.sent === false) db.prepare('DELETE FROM whatsapp_notices WHERE notice = ? AND phone = ?').run(req.params.notice, phone);
    else db.prepare('INSERT OR IGNORE INTO whatsapp_notices (notice, phone, sent_by) VALUES (?, ?, ?)').run(req.params.notice, phone, req.adminUser || 'panel');
    const list = recipients(req.params.notice, baseUrl);
    return res.json({ ok: true, total: list.length, sent: list.filter(r => r.sentAt).length });
  });

  app.get('/api/admin/whatsapp/contacts.vcf', (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'attachment; filename="compradores-entradas.vcf"');
    console.log(`[WhatsApp] ${req.adminUser} descargó los contactos de los compradores`);
    return res.type('text/vcard').send(contactsVcf());
  });
}

module.exports = { registerWhatsappNoticeRoutes, whatsappNumber, ticketPdfSignature, ticketPdfLink, scheduleLine, NOTICES };
