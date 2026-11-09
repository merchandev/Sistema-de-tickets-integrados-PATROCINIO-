function escapeHtml(value) { return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { ImapFlow } = require('imapflow');
const { db, getAllSettings, getPublicConfig } = require('./db');

/**
 * Creates a Nodemailer transporter using the current SMTP settings in the database.
 */
function getTransporter() {
  const s = getAllSettings();
  if (s.smtp_host) {
    return {
      isLiveSmtp: true,
      from: s.smtp_from || s.smtp_user,
      transporter: nodemailer.createTransport({
        host: s.smtp_host,
        port: parseInt(s.smtp_port || '587', 10),
        secure: s.smtp_secure === 'true' || s.smtp_port === '465',
        auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_pass } : undefined,
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000
      })
    };
  }
  // Fallback jsonTransport so it works seamlessly locally before real SMTP credentials are added
  return {
    isLiveSmtp: false,
    from: s.smtp_from || 'Entradas Labor Social <no-reply@laborsocial.org>',
    transporter: nodemailer.createTransport({
      jsonTransport: true
    })
  };
}

/**
 * IMAP client for the optional "Sent" copy. Without its own user/password it reuses the SMTP account,
 * which is the usual case when both belong to the same mailbox.
 */
function imapClient(s) {
  const port = parseInt(s.imap_port || '993', 10);
  const client = new ImapFlow({
    host: s.imap_host,
    port,
    secure: port === 993,
    auth: { user: s.imap_user || s.smtp_user, pass: s.imap_pass || s.smtp_pass },
    logger: false,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000
  });
  client.on('error', (err) => console.error('[IMAP Error]', err.message));
  return client;
}

async function findSentFolder(client) {
  const folders = await client.list();
  const sent = folders.find(f => f.specialUse === '\\Sent') || folders.find(f => /(^|[./])(sent|enviados)/i.test(f.path));
  return sent ? sent.path : 'Sent';
}

async function saveToSentFolder(s, mailOptions) {
  const raw = await new MailComposer(mailOptions).compile().build();
  const client = imapClient(s);
  try {
    await client.connect();
    await client.append(s.imap_sent_folder || await findSentFolder(client), raw, ['\\Seen']);
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Sends an email via SMTP (or local outbox if SMTP credentials are not yet set), keeps a copy in the
 * IMAP "Sent" folder when IMAP is configured, and records the message in `email_logs` for the Dashboard.
 */
async function sendSystemEmail({
  toEmail,
  toName,
  subject,
  html,
  type,
  orderId = null,
  ticketNumber = null,
  attachments = [],
  attachmentUrl = null
}) {
  const settings = getAllSettings();
  const { isLiveSmtp, from, transporter } = getTransporter();
  let status = isLiveSmtp ? 'SENT_SMTP' : 'SIMULATED_OUTBOX';
  let errorMessage = null;
  let imapSaved = false;
  const mailOptions = {
    from,
    to: toName ? { name: toName, address: toEmail } : toEmail,
    subject,
    html,
    attachments,
    messageId: `<${crypto.randomUUID()}@entradas>`,
    date: new Date()
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (err) {
    status = 'ERROR';
    errorMessage = err.message;
    console.error(`[SMTP Error] Failed to send email to ${toEmail}:`, err.message);
  }

  if (status === 'SENT_SMTP' && settings.imap_host) {
    try {
      await saveToSentFolder(settings, mailOptions);
      imapSaved = true;
    } catch (err) {
      errorMessage = `Enviado, pero no se guardó la copia en Enviados (IMAP): ${err.message}`;
      console.error('[IMAP Error] Could not save sent copy:', err.message);
    }
  }

  const insertStmt = db.prepare(`
    INSERT INTO email_logs (
      recipient_email, recipient_name, subject, type,
      order_id, ticket_number, status, body_html, attachment_path, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const res = insertStmt.run(
    toEmail,
    toName || '',
    subject,
    type,
    orderId,
    ticketNumber,
    status,
    html,
    attachmentUrl,
    errorMessage
  );

  return {
    logId: Number(res.lastInsertRowid),
    status,
    isLiveSmtp,
    imapSaved,
    errorMessage
  };
}

// ----------------------------------------------------------------------------
// Message layout, after the page the purchase came from
// ----------------------------------------------------------------------------

const BRANDS = {
  'pagina-web-1': { name: 'Iluminando Caminos', site: 'https://iluminandocaminos.com', ink: '#430c12', accent: '#8a141b', soft: '#f5ede0', line: '#e5c384' },
  'pagina-web-2': { name: 'Hablemos de Marketing', site: 'https://hablemosdemarketingmaturin.com', ink: '#130c24', accent: '#5b21d6', soft: '#f4f1ff', line: '#b8f500' }
};
const brandFor = (source) => BRANDS[source] || BRANDS['pagina-web-1'];

function formatDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) return value || 'Por confirmar';
  return new Intl.DateTimeFormat('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
}
function formatTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return value || '';
  const h = parseInt(m[1], 10);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}
const firstName = (order) => order.buyer_first_name || String(order.buyer_name || '').split(' ')[0];
const ticketLabel = (order) => order.ticket_number ? `#${order.ticket_number}` : 'Por asignar';

function paymentRows(order) {
  return [
    ['Entrada', ticketLabel(order)],
    ['Titular', order.buyer_name],
    ['Cédula', order.buyer_cedula],
    ['Banco de origen', order.payment_bank || '—'],
    ['Referencia', order.payment_reference],
    ['Monto', `Bs. ${Number(order.amount_ves || 0).toFixed(2)} ($${Number(order.amount_usd || 0).toFixed(2)} a tasa BCV ${Number(order.bcv_rate || 0).toFixed(2)})`]
  ];
}

function eventRows(cfg) {
  const concert = /^\d{1,2}:\d{2}$/.test(cfg.concert_end || '') ? `${formatTime(cfg.concert_start)} a ${formatTime(cfg.concert_end)}` : `Desde las ${formatTime(cfg.concert_start || '19:00')}`;
  return [
    ['Fecha', formatDate(cfg.event_date)],
    ['Ingreso', formatTime(cfg.event_entry_time || '15:30')],
    ['Lugar', cfg.event_location],
    ['Conferencia', `${formatTime(cfg.conference_start || '16:00')} a ${formatTime(cfg.conference_end || '19:00')}`],
    ['Concierto', concert]
  ];
}

// `paragraphs` are trusted HTML built here; every value from the buyer goes through escapeHtml.
function layout(brand, { preheader, title, paragraphs, rows = [], callout = '' }) {
  const rowsHtml = rows.map(([label, value]) => `
          <tr>
            <td style="padding:7px 12px 7px 0;color:#6b7280;font-size:13px;vertical-align:top;width:38%">${escapeHtml(label)}</td>
            <td style="padding:7px 0;color:#111827;font-size:14px;font-weight:600">${escapeHtml(value)}</td>
          </tr>`).join('');
  return `<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:${brand.soft};font-family:Arial,Helvetica,sans-serif;color:#111827">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${brand.soft};padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
        <tr><td style="background:${brand.ink};padding:20px 28px">
          <div style="color:#ffffff;font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">${escapeHtml(brand.name)}</div>
          <div style="width:44px;height:3px;background:${brand.line};margin-top:10px"></div>
        </td></tr>
        <tr><td style="padding:28px 28px 8px">
          <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:${brand.ink}">${escapeHtml(title)}</h1>
          ${paragraphs.map(p => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151">${p}</p>`).join('')}
          ${callout}
          ${rows.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 20px;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">${rowsHtml}</table>` : ''}
        </td></tr>
        <tr><td style="padding:16px 28px 22px;background:#f9fafb;color:#6b7280;font-size:12px;line-height:1.6">
          Sistema de entradas de <a href="${brand.site}" style="color:${brand.accent}">${escapeHtml(brand.name)}</a>. Si no hiciste esta compra, puedes ignorar este mensaje.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const callout = (brand, html) => `<div style="margin:16px 0;padding:14px 16px;border-left:3px solid ${brand.accent};background:${brand.soft};font-size:14px;line-height:1.6;color:#111827">${html}</div>`;

/**
 * 1. "Pago en verificación": sent when the buyer submits the popup form or a payment report.
 */
async function sendPaymentSubmittedEmail(order) {
  const brand = brandFor(order.source_web);
  const ticketText = order.ticket_number ? ` de la entrada <strong>#${escapeHtml(order.ticket_number)}</strong>` : '';
  const html = layout(brand, {
    preheader: 'Recibimos tu pago. La verificación puede tardar hasta 24 horas.',
    title: 'Tu pago está en verificación',
    paragraphs: [
      `Hola ${escapeHtml(firstName(order))}, recibimos el reporte de tu pago${ticketText}.`,
      'Cuando se confirme te enviaremos un correo de <strong>pago aceptado</strong> y, a continuación, tu entrada en PDF con el código QR para el ingreso.'
    ],
    callout: callout(brand, `Estamos verificando la transacción con el banco. <strong>El proceso puede tardar hasta 24 horas.</strong>${order.ticket_number ? '' : ' Al aprobarse te asignaremos una entrada disponible.'}`),
    rows: paymentRows(order)
  });

  return sendSystemEmail({
    toEmail: order.buyer_email,
    toName: order.buyer_name,
    subject: order.ticket_number ? `Pago en verificación · Entrada #${order.ticket_number} · ${brand.name}` : `Pago en verificación · ${brand.name}`,
    html,
    type: 'PAYMENT_RECEIVED',
    orderId: order.id,
    ticketNumber: order.ticket_number || null
  });
}

/**
 * 2. "Pago aceptado": sent as soon as the administrator approves the payment.
 */
async function sendPaymentApprovedEmail(order) {
  const brand = brandFor(order.source_web);
  const html = layout(brand, {
    preheader: `Tu entrada #${order.ticket_number} quedó confirmada.`,
    title: 'Tu pago fue aceptado',
    paragraphs: [
      `Hola ${escapeHtml(firstName(order))}, verificamos tu pago y la entrada <strong>#${escapeHtml(order.ticket_number)}</strong> quedó confirmada a tu nombre.`,
      'En un correo aparte te enviamos la entrada en PDF con tu información y el código QR que escanearemos en la puerta.'
    ],
    rows: paymentRows(order)
  });

  return sendSystemEmail({
    toEmail: order.buyer_email,
    toName: order.buyer_name,
    subject: `Pago aceptado · Entrada #${order.ticket_number} · ${brand.name}`,
    html,
    type: 'PAYMENT_APPROVED',
    orderId: order.id,
    ticketNumber: order.ticket_number
  });
}

/**
 * 3. The ticket itself, with the PDF (buyer data + QR) attached.
 */
async function sendTicketEmail(order, pdfFullPath, pdfRelativeUrl) {
  const cfg = getPublicConfig();
  const brand = brandFor(order.source_web);
  const html = layout(brand, {
    preheader: 'Tu entrada en PDF con el código QR para el ingreso.',
    title: `Tu entrada #${order.ticket_number}`,
    paragraphs: [
      `Hola ${escapeHtml(firstName(order))}, adjuntamos tu entrada en PDF para <strong>${escapeHtml(cfg.event_title)}</strong>.`,
      'Preséntala en tu teléfono o impresa junto con tu cédula de identidad. En la puerta escanearemos su código QR; es personal y vale para un solo ingreso a cada parte del evento.'
    ],
    callout: callout(brand, `Entrada <strong>#${escapeHtml(order.ticket_number)}</strong> · ${escapeHtml(order.buyer_name)} · C.I. ${escapeHtml(order.buyer_cedula)}`),
    rows: eventRows(cfg)
  });

  return sendSystemEmail({
    toEmail: order.buyer_email,
    toName: order.buyer_name,
    subject: `Tu entrada #${order.ticket_number} · ${brand.name}`,
    html,
    type: 'TICKET_APPROVED',
    orderId: order.id,
    ticketNumber: order.ticket_number,
    attachments: pdfFullPath
      ? [{ filename: `ENTRADA-${order.ticket_number}.pdf`, path: pdfFullPath }]
      : [],
    attachmentUrl: pdfRelativeUrl
  });
}

/**
 * 4. Sent when the administrator rejects a payment.
 */
async function sendPaymentRejectedEmail(order, reason) {
  const brand = brandFor(order.source_web);
  const html = layout(brand, {
    preheader: 'No pudimos verificar tu pago.',
    title: 'No pudimos verificar tu pago',
    paragraphs: [
      `Hola ${escapeHtml(firstName(order))}, revisamos el pago con referencia <strong>${escapeHtml(order.payment_reference)}</strong> y no pudimos confirmarlo.`,
      order.ticket_number
        ? `La entrada #${escapeHtml(order.ticket_number)} quedó libre nuevamente. Si se trata de un error en los datos, vuelve a la página y reporta el pago con la información correcta.`
        : 'Si se trata de un error en los datos, vuelve a la página y reporta el pago con la información correcta.'
    ],
    callout: callout(brand, `<strong>Motivo:</strong> ${escapeHtml(reason || 'La referencia o el monto no coinciden con una transacción recibida.')}`),
    rows: paymentRows(order)
  });

  return sendSystemEmail({
    toEmail: order.buyer_email,
    toName: order.buyer_name,
    subject: `No pudimos verificar tu pago · ${brand.name}`,
    html,
    type: 'PAYMENT_REJECTED',
    orderId: order.id,
    ticketNumber: order.ticket_number || null
  });
}

/**
 * 5. Sends mass event notifications to all approved buyers:
 * - REMINDER_2_DAYS ("Faltan 2 días")
 * - REMINDER_1_DAY ("Falta 1 día")
 * - REMINDER_TODAY ("¡Falta hoy! Hoy es el evento")
 * - EVENT_STARTED ("¡Ya comenzamos el evento!")
 */
async function sendEventCampaignNotification(campaignKey, triggeredBy = 'MANUAL_ADMIN') {
  const cfg = getPublicConfig();
  const approvedOrders = db.prepare(`
    SELECT * FROM orders WHERE status = 'APPROVED' ORDER BY ticket_number ASC
  `).all();

  const templates = {
    REMINDER_2_DAYS: {
      subjectPrefix: 'Faltan 2 días',
      headline: 'Faltan solo 2 días para el encuentro',
      intro: 'Tu entrada incluye acceso completo a la conferencia y al concierto.'
    },
    REMINDER_1_DAY: {
      subjectPrefix: 'Mañana nos vemos',
      headline: 'Mañana es el gran día',
      intro: 'Ten a mano tu entrada en PDF y tu cédula de identidad.'
    },
    REMINDER_TODAY: {
      subjectPrefix: 'Es hoy',
      headline: 'Hoy es el evento',
      intro: `Te esperamos en ${escapeHtml(cfg.event_location)}. Presenta tu código QR en la puerta.`
    },
    EVENT_STARTED: {
      subjectPrefix: 'Ya comenzamos',
      headline: 'Ya comenzamos el evento',
      intro: 'Las puertas están abiertas. Presenta tu código QR en la entrada para registrar tu ingreso.'
    }
  };

  const tpl = templates[campaignKey];
  if (!tpl) {
    throw new Error(`Tipo de notificación inválido: ${campaignKey}`);
  }

  let sentCount = 0;
  for (const order of approvedOrders) {
    const brand = brandFor(order.source_web);
    const html = layout(brand, {
      preheader: tpl.headline,
      title: tpl.headline,
      paragraphs: [`Hola ${escapeHtml(firstName(order))} (entrada <strong>#${escapeHtml(order.ticket_number)}</strong>).`, tpl.intro],
      rows: eventRows(cfg)
    });

    await sendSystemEmail({
      toEmail: order.buyer_email,
      toName: order.buyer_name,
      subject: `${tpl.subjectPrefix} · Entrada #${order.ticket_number} · ${brand.name}`,
      html,
      type: campaignKey,
      orderId: order.id,
      ticketNumber: order.ticket_number,
      attachmentUrl: order.pdf_path || null
    });
    sentCount++;
  }

  db.prepare(`
    INSERT INTO notification_campaigns (campaign_key, triggered_by, recipients_count)
    VALUES (?, ?, ?)
  `).run(campaignKey, triggeredBy, sentCount);

  return {
    campaignKey,
    triggeredBy,
    recipientsCount: sentCount
  };
}

/**
 * Checks the saved SMTP and IMAP accounts for the dashboard and optionally sends a test message.
 */
async function testMailConnections(to = '') {
  const s = getAllSettings();
  const result = {
    smtp: { ok: false, message: 'Configura el servidor SMTP para enviar correos reales.' },
    imap: { ok: null, message: 'IMAP sin configurar: los correos se envían igual, pero no se guarda copia en Enviados.' },
    sent: null
  };

  if (s.smtp_host) {
    try {
      await getTransporter().transporter.verify();
      result.smtp = { ok: true, message: `SMTP conectado con ${s.smtp_host}.` };
    } catch (err) {
      result.smtp = { ok: false, message: `SMTP: ${err.message}` };
    }
  }

  if (s.imap_host) {
    const client = imapClient(s);
    try {
      await client.connect();
      const folder = s.imap_sent_folder || await findSentFolder(client);
      result.imap = { ok: true, message: `IMAP conectado con ${s.imap_host}. Las copias se guardarán en "${folder}".` };
    } catch (err) {
      result.imap = { ok: false, message: `IMAP: ${err.responseText || err.message}` };
    } finally {
      await client.logout().catch(() => {});
    }
  }

  if (to && result.smtp.ok) {
    const brand = brandFor('pagina-web-1');
    const sent = await sendSystemEmail({
      toEmail: to,
      subject: 'Correo de prueba · Sistema de entradas',
      html: layout(brand, { preheader: 'Correo de prueba', title: 'La configuración de correo funciona', paragraphs: ['Este es un mensaje de prueba enviado desde el panel de administración.'] }),
      type: 'TEST'
    });
    result.sent = sent.status === 'SENT_SMTP'
      ? { ok: true, message: `Correo de prueba enviado a ${to}.${sent.imapSaved ? ' Se guardó una copia en Enviados.' : ''}${sent.errorMessage ? ` ${sent.errorMessage}` : ''}` }
      : { ok: false, message: `No se pudo enviar el correo de prueba: ${sent.errorMessage}` };
  }

  return result;
}

module.exports = {
  sendPaymentSubmittedEmail,
  sendPaymentApprovedEmail,
  sendTicketEmail,
  sendPaymentRejectedEmail,
  sendEventCampaignNotification,
  testMailConnections
};
