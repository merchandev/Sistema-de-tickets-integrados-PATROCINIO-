// Event reminders: Caracas schedule, one message per buyer address, provider rate-limit detection.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campanas-'));
process.env.DATA_DIR = dataDir;
process.env.CAMPAIGNS_AUTO = 'false';
process.env.CAMPAIGN_PACE_MS = '1';
process.env.MAIL_COOLDOWN_MS = '60000';
const campaigns = require('../sistema-central/src/campaigns');
const { db } = require('../sistema-central/src/db');
const mailer = require('../sistema-central/src/mailer');

const cfg = { event_date: '2026-11-21', conference_start: '16:00' };
// Caracas is UTC-4 all year
const at = (local) => new Date(`${local}:00-04:00`);

test('Programa los avisos del día del evento a las 7:00 AM, 12:00 PM y 3:59 PM (hora de Venezuela)', () => {
  const plan = Object.fromEntries(campaigns.schedule(cfg).map(c => [c.key, c.at]));
  assert.deepEqual(plan, {
    REMINDER_2_DAYS: '2026-11-19 09:00',
    REMINDER_1_DAY: '2026-11-20 09:00',
    REMINDER_TODAY: '2026-11-21 07:00',
    REMINDER_REGISTRATION: '2026-11-21 12:00',
    EVENT_STARTED: '2026-11-21 15:59'
  });
  assert.equal(campaigns.caracasClock(new Date('2026-11-21T11:00:00Z')), '2026-11-21 07:00');
});

test('Cada aviso está vigente desde su hora hasta el siguiente, y nada sale de noche', () => {
  const cases = [
    ['2026-11-21T06:59', null],
    ['2026-11-21T07:00', 'REMINDER_TODAY'],
    ['2026-11-21T11:59', 'REMINDER_TODAY'],
    ['2026-11-21T12:00', 'REMINDER_REGISTRATION'],
    ['2026-11-21T15:58', 'REMINDER_REGISTRATION'],
    ['2026-11-21T15:59', 'EVENT_STARTED'],
    ['2026-11-21T21:59', 'EVENT_STARTED'],
    ['2026-11-21T22:00', null],
    ['2026-11-20T23:30', null],
    ['2026-11-20T10:00', 'REMINDER_1_DAY'],
    ['2026-11-22T10:00', null],
    ['2026-11-18T10:00', null]
  ];
  for (const [local, expected] of cases) assert.equal(campaigns.activeCampaign(cfg, at(local)), expected, local);
  assert.equal(campaigns.activeCampaign({ ...cfg, conference_start: '17:30' }, at('2026-11-21T17:29')), 'EVENT_STARTED');
  assert.equal(campaigns.activeCampaign({ event_date: '' }, at('2026-11-21T10:00')), null);
});

test('Un correo por dirección con todas sus entradas, y nunca a quien ya lo recibió', () => {
  const insert = db.prepare(`INSERT INTO orders (ticket_number, source_web, session_id, buyer_name, buyer_cedula, buyer_phone,
    buyer_email, payment_phone, payment_reference, screenshot_path, amount_usd, bcv_rate, amount_ves, status)
    VALUES (?, 'pagina-web-1', 's', ?, 'V1', '0414', ?, '0414', 'R', 'x', 5, 1, 5, ?)`);
  insert.run('003', 'Ana', 'Ana@Correo.test', 'APPROVED');
  insert.run('001', 'Ana', 'ana@correo.test ', 'APPROVED');
  insert.run('002', 'Luis', 'luis@correo.test', 'APPROVED');
  insert.run('004', 'Eva', 'eva@correo.test', 'PENDING');
  insert.run('005', 'Rita', 'rita@correo.test', 'REJECTED');
  let groups = campaigns.pendingRecipients('REMINDER_TODAY');
  assert.deepEqual(groups.map(g => g.map(o => o.ticket_number)), [['001', '003'], ['002']]);

  const log = db.prepare(`INSERT INTO email_logs (recipient_email, recipient_name, subject, type, status) VALUES (?, '', 's', ?, ?)`);
  log.run('ANA@correo.test', 'REMINDER_TODAY', 'SENT_SMTP');
  log.run('luis@correo.test', 'REMINDER_TODAY', 'ERROR');
  groups = campaigns.pendingRecipients('REMINDER_TODAY');
  assert.deepEqual(groups.map(g => g.map(o => o.ticket_number)), [['002']], 'un intento fallido sigue pendiente');
  assert.equal(campaigns.pendingRecipients('EVENT_STARTED').length, 2, 'cada aviso se cuenta por separado');
});

test('Reconoce los rechazos por límite de envío de Hostinger', () => {
  for (const message of [
    'Message failed: 451 4.7.1 Ratelimit "hostinger_out_ratelimit" exceeded for key "x"',
    'Mail command failed: 450 4.7.1 Error: too many messages from 72.62.86.94'
  ]) assert.match(message, campaigns.RATE_LIMITED);
  for (const message of ['Invalid login: 535 Authentication failed', 'getaddrinfo ENOTFOUND smtp.ejemplo.test', 'Recipient address rejected: 550 5.1.1']) {
    assert.doesNotMatch(message, campaigns.RATE_LIMITED);
  }
});

test('Si Hostinger limita el envío, se detiene, no repite y conserva a quien falta', async () => {
  const sent = [];
  mailer.mailDeliveryMode = () => 'smtp';
  mailer.undeliveredOrderEmails = () => [];
  const log = db.prepare(`INSERT INTO email_logs (recipient_email, recipient_name, subject, type, status, error_message) VALUES (?, '', 's', ?, ?, ?)`);
  mailer.sendCampaignEmail = async (key, orders) => {
    const email = orders[0].buyer_email;
    if (sent.length >= 1) {
      log.run(email, key, 'ERROR', 'Message failed: 451 4.7.1 Ratelimit "hostinger_out_ratelimit" exceeded');
      return { status: 'ERROR', errorMessage: 'Message failed: 451 4.7.1 Ratelimit "hostinger_out_ratelimit" exceeded' };
    }
    sent.push(email);
    log.run(email, key, 'SENT_SMTP', null);
    return { status: 'SENT_SMTP' };
  };
  const insert = db.prepare(`INSERT INTO orders (ticket_number, source_web, session_id, buyer_name, buyer_cedula, buyer_phone,
    buyer_email, payment_phone, payment_reference, screenshot_path, amount_usd, bcv_rate, amount_ves, status)
    VALUES (?, 'pagina-web-2', 's', 'X', 'V1', '0414', ?, '0414', 'R', 'x', 5, 1, 5, 'APPROVED')`);
  insert.run('010', 'uno@correo.test');
  insert.run('011', 'dos@correo.test');
  const before = campaigns.pendingRecipients('EVENT_STARTED').length;
  const queued = campaigns.queueCampaign('EVENT_STARTED');
  assert.equal(queued.ok, true);
  await new Promise(r => setTimeout(r, 300));
  const after = campaigns.status();
  assert.equal(sent.length, 1, 'envía uno y se detiene al primer rechazo por límite');
  assert.equal(campaigns.pendingRecipients('EVENT_STARTED').length, before - 1, 'los demás siguen pendientes');
  assert.ok(after.pausedUntil, 'queda en pausa hasta que pase el enfriamiento');
  await campaigns.tick();
  assert.equal(sent.length, 1, 'durante la pausa no intenta más envíos');
  const row = db.prepare("SELECT recipients_count FROM notification_campaigns WHERE campaign_key = 'EVENT_STARTED' AND triggered_by = 'MANUAL_ADMIN'").get();
  assert.equal(row.recipients_count, 1, 'el historial cuenta solo los entregados');
});

test.after(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
