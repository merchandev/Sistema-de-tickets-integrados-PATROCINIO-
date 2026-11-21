// Event reminder emails and automatic resends.
//
// Hostinger accepts about a hundred messages in a burst and then answers "Ratelimit exceeded" or
// "too many messages" for a while. So reminders go out one buyer at a time, with a pause between
// messages; when the provider limits the rate, sending stops for a cool-down and resumes with whoever
// is still missing. Each buyer address gets each reminder once (all their tickets in one message),
// and buyers approved later still get the reminder that is current when they are approved.
//
// Schedule (Caracas time): 2 and 1 days before at 9:00 AM; on the event day "Es hoy" at 7:00 AM,
// the registration reminder at 12:00 PM and "Ya comenzamos" one minute before the conferences.
// A reminder is current from its time until the next one starts, only on its own day and never at night.
const { db, getPublicConfig } = require('./db');
const mailer = require('./mailer');

const PACE_MS = Number(process.env.CAMPAIGN_PACE_MS || 8000);
const COOLDOWN_MS = Number(process.env.MAIL_COOLDOWN_MS || 3 * 60 * 1000);
const TICK_MS = Number(process.env.CAMPAIGN_TICK_MS || 30 * 1000);
const AUTO = process.env.CAMPAIGNS_AUTO !== 'false';
const QUIET_FROM = '22:00';
const QUIET_TO = '06:00';
// Undelivered payment and ticket notices are retried every 3 minutes until they reach the buyer.
const RESEND_GAP_MS = Number(process.env.MAIL_RESEND_GAP_MS || 3 * 60 * 1000);

const LABELS = {
  REMINDER_2_DAYS: 'Faltan 2 días',
  REMINDER_1_DAY: 'Falta 1 día',
  REMINDER_TODAY: 'Es hoy',
  REMINDER_REGISTRATION: 'Recordatorio del registro',
  EVENT_STARTED: 'Ya comenzamos'
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const { RATE_LIMITED } = mailer;

// Caracas wall clock as "YYYY-MM-DD HH:MM", independent of the server's time zone.
function caracasClock(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
function minuteBefore(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  const total = m ? Number(m[1]) * 60 + Number(m[2]) - 1 : 15 * 60 + 59;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function schedule(cfg) {
  const day = cfg.event_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return [];
  return [
    { key: 'REMINDER_2_DAYS', at: `${shiftDate(day, -2)} 09:00` },
    { key: 'REMINDER_1_DAY', at: `${shiftDate(day, -1)} 09:00` },
    { key: 'REMINDER_TODAY', at: `${day} 07:00` },
    { key: 'REMINDER_REGISTRATION', at: `${day} 12:00` },
    { key: 'EVENT_STARTED', at: `${day} ${minuteBefore(cfg.conference_start || '16:00')}` }
  ].map((item, i, all) => {
    // Current until the next reminder starts, and never past its own day's quiet hours
    const sameNight = `${item.at.slice(0, 10)} ${QUIET_FROM}`;
    const next = all[i + 1]?.at;
    return { ...item, label: LABELS[item.key], until: next && next < sameNight ? next : sameNight };
  });
}

// The reminder that should be going out now, or null (none due, or quiet hours).
function activeCampaign(cfg, now = new Date()) {
  const clock = caracasClock(now);
  const time = clock.slice(11);
  if (time >= QUIET_FROM || time < QUIET_TO) return null;
  return schedule(cfg).find(item => item.at <= clock && clock < item.until)?.key || null;
}

// Approved buyers grouped by address, minus the addresses that already received this reminder.
function pendingRecipients(campaignKey) {
  const delivered = new Set(db.prepare(`
    SELECT DISTINCT lower(trim(recipient_email)) AS email FROM email_logs WHERE type = ? AND status = 'SENT_SMTP'
  `).all(campaignKey).map(r => r.email));
  const groups = new Map();
  for (const order of db.prepare(`
    SELECT * FROM orders WHERE status = 'APPROVED' AND trim(coalesce(buyer_email, '')) != '' AND ticket_number != ''
    ORDER BY ticket_number
  `).all()) {
    const email = order.buyer_email.trim().toLowerCase();
    if (delivered.has(email)) continue;
    if (!groups.has(email)) groups.set(email, []);
    groups.get(email).push(order);
  }
  return [...groups.values()];
}

// One row per reminder, origin and Caracas day in the panel's history, counting delivered messages.
function recordCampaign(campaignKey, triggeredBy, delivered) {
  if (!delivered) return;
  const row = db.prepare(`SELECT id FROM notification_campaigns WHERE campaign_key = ? AND triggered_by = ?
    AND date(created_at, '-4 hours') = date('now', '-4 hours') ORDER BY id DESC LIMIT 1`).get(campaignKey, triggeredBy);
  if (row) db.prepare('UPDATE notification_campaigns SET recipients_count = recipients_count + ? WHERE id = ?').run(delivered, row.id);
  else db.prepare('INSERT INTO notification_campaigns (campaign_key, triggered_by, recipients_count) VALUES (?, ?, ?)').run(campaignKey, triggeredBy, delivered);
}

const state = { running: false, blockedUntil: 0, lastError: '', manual: new Set(), current: null, sent: 0,
  force: false, resendDelivered: 0, resending: false, lastCheck: 0 };
let progressListener = () => {};
const progress = () => { try { progressListener(); } catch (_) { /* the panel refreshes on its own */ } };

function noteFailure(errorMessage) {
  state.lastError = errorMessage || '';
  if (RATE_LIMITED.test(errorMessage || '')) {
    state.blockedUntil = Date.now() + COOLDOWN_MS;
    console.warn(`[Campañas] El proveedor de correo limitó el envío. Se reanuda en ${Math.round(COOLDOWN_MS / 60000)} min.`);
    progress();
    return true;
  }
  return false;
}
const blocked = () => Date.now() < state.blockedUntil;

const lastAttempt = (row) => Date.parse(`${String(db.prepare('SELECT MAX(created_at) AS last FROM email_logs WHERE order_id = ? AND type = ?').get(row.order_id, row.type).last).replace(' ', 'T')}Z`);

// Payment and ticket notices that never reached the buyer (every ticket of every order, even when a
// buyer used the same address several times), retried every 3 minutes until delivered.
async function resendUndelivered() {
  const force = state.force;
  state.force = false;
  state.lastCheck = Date.now();
  const rows = mailer.undeliveredOrderEmails();
  if (!rows.length) { state.resendDelivered = 0; return; }
  state.resending = true;
  try {
  for (const row of rows) {
    if (blocked()) return;
    if (!force && Date.now() - lastAttempt(row) < RESEND_GAP_MS) continue;
    const result = await mailer.retryOrderEmail(row.id);
    // Only a new attempt that failed says something about the provider (not an order that changed)
    const latest = db.prepare('SELECT id, status, error_message FROM email_logs WHERE order_id = ? AND type = ? ORDER BY id DESC LIMIT 1').get(row.order_id, row.type);
    if (latest.id === row.id) continue;
    if (result.ok) { state.resendDelivered++; progress(); }
    else if (latest.status === 'ERROR' && noteFailure(latest.error_message)) return;
    await sleep(PACE_MS);
  }
  } finally {
    state.resending = false;
    progress();
  }
}

async function sendCampaign(campaignKey, triggeredBy, stillWanted) {
  let delivered = 0;
  try {
    for (const orders of pendingRecipients(campaignKey)) {
      if (blocked() || !stillWanted()) break;
      state.current = campaignKey;
      const result = await mailer.sendCampaignEmail(campaignKey, orders);
      if (result.status === 'SENT_SMTP') { delivered++; state.sent++; progress(); }
      else if (noteFailure(result.errorMessage)) break;
      await sleep(PACE_MS);
    }
  } finally {
    recordCampaign(campaignKey, triggeredBy, delivered);
    state.current = null;
  }
  return pendingRecipients(campaignKey).length;
}

async function tick() {
  if (state.running) return;
  state.running = true;
  try {
    if (mailer.mailDeliveryMode() !== 'smtp' || blocked()) return;
    state.lastCheck = Date.now();
    await resendUndelivered();
    for (const key of [...state.manual]) {
      if (blocked()) return;
      const left = await sendCampaign(key, 'MANUAL_ADMIN', () => state.manual.has(key));
      if (!left) state.manual.delete(key);
    }
    const cfg = getPublicConfig();
    const key = AUTO && activeCampaign(cfg);
    if (key && !blocked()) await sendCampaign(key, 'AUTO_CRON', () => activeCampaign(getPublicConfig()) === key);
  } catch (err) {
    console.error('[Campañas] Error en el envío programado:', err.message);
  } finally {
    state.running = false;
  }
}

// Manual button: queue the reminder for every buyer who has not received it yet (never twice).
function queueCampaign(campaignKey) {
  if (!mailer.CAMPAIGN_KEYS.includes(campaignKey)) return { ok: false, status: 400, message: `Tipo de notificación inválido: ${campaignKey}` };
  if (mailer.mailDeliveryMode() !== 'smtp') return { ok: false, status: 409, message: 'Configura y prueba un servidor SMTP real antes de enviar avisos.' };
  const pending = pendingRecipients(campaignKey).length;
  if (!pending) return { ok: true, pending, message: `Todos los compradores ya recibieron «${LABELS[campaignKey]}».` };
  state.manual.add(campaignKey);
  setImmediate(tick);
  const minutes = Math.max(1, Math.ceil(pending * PACE_MS / 60000));
  return { ok: true, pending, message: `«${LABELS[campaignKey]}» se está enviando a ${pending} comprador(es) que aún no lo recibieron, uno a uno (unos ${minutes} min). Si el proveedor limita el envío, se reanuda solo.` };
}

// "Reenviar ahora": retry every undelivered notice right away, without waiting for the 3-minute gap.
function forceResend() {
  if (mailer.mailDeliveryMode() !== 'smtp') return { ok: false, status: 409, message: 'Configura y prueba un servidor SMTP real antes de reenviar.' };
  const pending = mailer.undeliveredOrderEmails().length;
  if (!pending) return { ok: true, pending, message: 'No hay avisos pendientes: todos llegaron a los compradores.' };
  state.force = true;
  state.blockedUntil = 0;
  setImmediate(tick);
  return { ok: true, pending, message: `Reenviando ${pending} aviso(s) pendiente(s), uno a uno. La barra muestra el avance; si el proveedor limita el envío, se reintenta solo cada 3 minutos.` };
}

// Progress of the automatic resends for the panel's banner
function resendStatus(now = Date.now()) {
  const rows = mailer.undeliveredOrderEmails();
  const pending = rows.length;
  if (!pending && !state.resending) state.resendDelivered = 0;
  const due = rows.map(row => lastAttempt(row) + RESEND_GAP_MS);
  const next = Math.max(state.blockedUntil, due.length ? Math.min(...due) : 0, state.lastCheck + TICK_MS);
  return {
    pending,
    delivered: state.resendDelivered,
    total: pending + state.resendDelivered,
    sending: state.resending,
    pausedUntil: state.blockedUntil > now ? new Date(state.blockedUntil).toISOString() : null,
    nextCheckAt: pending ? new Date(Math.max(next, now)).toISOString() : null,
    intervalMinutes: Math.round(RESEND_GAP_MS / 60000)
  };
}

function status(now = new Date()) {
  const cfg = getPublicConfig();
  return {
    automatic: AUTO,
    active: activeCampaign(cfg, now),
    sending: state.current,
    queued: [...state.manual],
    pausedUntil: blocked() ? new Date(state.blockedUntil).toISOString() : null,
    lastError: state.lastError,
    schedule: schedule(cfg).map(item => ({ ...item, pending: pendingRecipients(item.key).length }))
  };
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 5000);
}

const onProgress = (fn) => { progressListener = fn; };

module.exports = { start, tick, queueCampaign, forceResend, resendStatus, onProgress, status, schedule, activeCampaign, caracasClock, pendingRecipients, RATE_LIMITED };
