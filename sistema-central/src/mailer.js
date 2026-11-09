function escapeHtml(value) { return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { ImapFlow } = require('imapflow');
const { db, getAllSettings, getPublicConfig } = require('./db');

// Address and domain of the configured sender ("Nombre <correo@dominio>" or a bare address).
function senderAddress(from) {
  const m = /<([^>]+)>/.exec(String(from || ''));
  return (m ? m[1] : String(from || '')).trim();
}
const senderDomain = (from) => senderAddress(from).split('@')[1] || 'localhost';

// Plain-text alternative of the HTML layout: mail filters distrust HTML-only messages.
function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<span style="display:none[^>]*>[\s\S]*?<\/span>/i, '')
    .replace(/<\/td>\s*<td[^>]*>/gi, ': ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<br\s*\/?>|<\/(p|h[12]|div|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Creates a Nodemailer transporter using the current SMTP settings in the database.
 */
function mailDeliveryMode(settings = getAllSettings()) {
  const host = String(settings.smtp_host || '').trim().toLowerCase();
  if (!host) return 'disabled';
  return /^mailpit(?:\.|$)/.test(host) ? 'mailpit' : 'smtp';
}

function getTransporter(s) {
  if (s.smtp_host) {
    const from = s.smtp_from || s.smtp_user;
    return {
      isLiveSmtp: mailDeliveryMode(s) === 'smtp',
      from,
      transporter: nodemailer.createTransport({
        host: s.smtp_host,
        port: parseInt(s.smtp_port || '587', 10),
        secure: s.smtp_secure === 'true' || s.smtp_port === '465',
        // Greet the server with the sender's domain instead of the container's random hostname
        name: senderDomain(from),
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
  const { isLiveSmtp, from, transporter } = getTransporter(settings);
  let status = isLiveSmtp ? 'SENT_SMTP' : 'SIMULATED_OUTBOX';
  let errorMessage = null;
  let imapSaved = false;
  const mailOptions = {
    from,
    replyTo: senderAddress(from),
    to: toName ? { name: toName, address: toEmail } : toEmail,
    subject,
    html,
    text: htmlToText(html),
    attachments,
    messageId: `<${crypto.randomUUID()}@${senderDomain(from)}>`,
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

  // One line per message in the container log (no personal data beyond the recipient's domain)
  console.log(`[Mail] ${type} -> ${status}${imapSaved ? ' + copia en Enviados' : ''} (@${String(toEmail).split('@')[1] || '?'})${errorMessage ? `: ${errorMessage}` : ''}`);

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
// Both logos on the ticket gradient (scripts/generar-cabecera-correo.cjs), served publicly by this system
const HEADER_IMAGE_URL = `${String(process.env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/$/, '')}/api/public/email/cabecera.jpg?v=1`;
const brandLink = ({ site, accent, name }) => `<a href="${site}" style="color:${accent}">${escapeHtml(name)}</a>`;

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
const fullEventAccess = 'Tu entrada incluye acceso a todo el evento, desde las conferencias hasta el concierto.';

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
    ['Apertura de puertas', formatTime(cfg.event_entry_time || '15:30')],
    ['Lugar', cfg.event_location],
    ['Conferencias', `${formatTime(cfg.conference_start || '16:00')} a ${formatTime(cfg.conference_end || '19:00')}`],
    ['Concierto', concert]
  ];
}

// `paragraphs` are trusted HTML built here; every value from the buyer goes through escapeHtml.
function layout(brand, { preheader, title, paragraphs, rows = [], rowsTitle = '', callout = '' }) {
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
        <tr><td bgcolor="#220408" style="background:#220408;padding:0">
          <img src="${HEADER_IMAGE_URL}" width="560" alt="Iluminando Caminos · Hablemos de Marketing" style="display:block;width:100%;max-width:560px;height:auto;border:0;color:#ffffff;font:700 14px Arial,Helvetica,sans-serif;text-align:center" />
        </td></tr>
        <tr><td style="padding:28px 28px 8px">
          <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:${brand.ink}">${escapeHtml(title)}</h1>
          ${paragraphs.map(p => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151">${p}</p>`).join('')}
          ${callout}
          ${rowsTitle ? `<h2 style="margin:18px 0 8px;font-size:16px;line-height:1.4;color:${brand.ink}">${escapeHtml(rowsTitle)}</h2>` : ''}
          ${rows.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">${rowsHtml}</table>` : ''}
        </td></tr>
        <tr><td style="padding:16px 28px 22px;background:#f9fafb;color:#6b7280;font-size:12px;line-height:1.6">
          Sistema de entradas de ${brandLink(BRANDS['pagina-web-2'])} e ${brandLink(BRANDS['pagina-web-1'])}. Si no hiciste esta compra, puedes ignorar este mensaje.
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
    preheader: 'Recibimos tu reporte de pago y estamos revisando la transacción.',
    title: 'Tu pago está en verificación',
    paragraphs: [
      `Hola ${escapeHtml(firstName(order))}, recibimos el reporte de tu pago${ticketText}. Revisaremos la referencia y el monto para confirmar la transacción con el banco.`,
      'Te avisaremos por este mismo correo cuando termine la revisión. Si aprobamos el pago, recibirás tu entrada en PDF con el QR para acceder a todo el evento, incluidas las conferencias y el concierto.'
    ],
    callout: callout(brand, `<strong>La verificación puede tardar hasta 24 horas.</strong>${order.ticket_number ? ' Guarda el comprobante y la referencia mientras revisamos tu reporte.' : ' Si aprobamos el pago, te asignaremos una entrada disponible.'}`),
    rowsTitle: 'Datos del pago reportado',
    rows: paymentRows(order)
  });

  return sendSystemEmail({
    toEmail: order.buyer_email,
    toName: order.buyer_name,
    subject: 'Estamos verificando tu pago',
    html,
    type: 'PAYMENT_RECEIVED',
    orderId: order.id,
    ticketNumber: order.ticket_number || null
  });
}

/**
 * 2. Sent when the administrator approves the payment: confirms it and carries the ticket PDF
 * (buyer data + QR) in a single message.
 */
async function sendTicketEmail(order, pdfFullPath, pdfRelativeUrl) {
  const cfg = getPublicConfig();
  const brand = brandFor(order.source_web);
  const html = layout(brand, {
    preheader: `Pago confirmado. Descarga tu entrada #${order.ticket_number} y ten el QR a mano para el ingreso.`,
    title: 'Tu pago fue aprobado y tu entrada está lista',
    paragraphs: [
      `Hola ${escapeHtml(firstName(order))}, gracias por apoyar <strong>${escapeHtml(cfg.event_title)}</strong>. Confirmamos tu pago y adjuntamos la entrada en PDF a nombre de <strong>${escapeHtml(order.buyer_name)}</strong>.`,
      fullEventAccess,
      'Descarga el PDF antes de salir para tenerlo a mano aunque no tengas conexión. En la puerta puedes mostrar el QR en tu teléfono o llevarlo impreso. Ten también a mano tu cédula de identidad.'
    ],
    callout: callout(brand, `<strong>Entrada #${escapeHtml(order.ticket_number)}</strong> · Pago confirmado con la referencia ${escapeHtml(order.payment_reference)}.`),
    rowsTitle: 'Fecha, lugar y horarios del evento',
    rows: eventRows(cfg)
  });

  return sendSystemEmail({
    toEmail: order.buyer_email,
    toName: order.buyer_name,
    subject: 'Muchas gracias por su apoyo, tu entrada está disponible',
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
 * 3. Sent when the administrator rejects a payment.
 */
async function sendPaymentRejectedEmail(order, reason) {
  const brand = brandFor(order.source_web);
  const html = layout(brand, {
    preheader: 'Consulta el motivo de la decisión y cómo corregir tu reporte.',
    title: 'No pudimos verificar tu pago',
    paragraphs: [
      `Hola ${escapeHtml(firstName(order))}, revisamos el pago con referencia <strong>${escapeHtml(order.payment_reference)}</strong> y no pudimos confirmarlo.`,
      ...(order.ticket_number ? [`La entrada #${escapeHtml(order.ticket_number)} volvió a estar disponible.`] : []),
      `Si detectas un error, compara la referencia, el monto y el banco con tu comprobante. Luego usa <a href="${brand.site}/comprar.html#reportar-pago" style="color:${brand.accent}">Reportar un pago</a> para enviarnos los datos corregidos y una captura legible de la transacción.`
    ],
    callout: callout(brand, `<strong>Motivo:</strong> ${escapeHtml(reason || 'La referencia o el monto no coinciden con una transacción recibida.')}`),
    rowsTitle: 'Datos que revisamos',
    rows: paymentRows(order)
  });

  return sendSystemEmail({
    toEmail: order.buyer_email,
    toName: order.buyer_name,
    subject: 'Pago rechazado',
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
      intro: 'Revisa la hora de apertura y el lugar para planificar tu llegada. Puedes descargar desde ahora el PDF que recibiste al aprobarse tu pago.'
    },
    REMINDER_1_DAY: {
      subjectPrefix: 'Mañana nos vemos',
      headline: 'Mañana es el gran día',
      intro: 'Antes de salir, guarda el PDF de tu entrada en el teléfono o imprímelo. Lleva también tu cédula de identidad para mostrarla en el acceso.'
    },
    REMINDER_TODAY: {
      subjectPrefix: 'Es hoy',
      headline: 'Hoy es el evento',
      intro: `Te esperamos en <strong>${escapeHtml(cfg.event_location)}</strong>. Las puertas abren a las ${escapeHtml(formatTime(cfg.event_entry_time || '15:30'))}. Al llegar, muestra el QR de tu entrada y tu cédula.`
    },
    EVENT_STARTED: {
      subjectPrefix: 'Ya comenzamos',
      headline: 'Ya comenzamos el evento',
      intro: 'Las puertas están abiertas. Si vienes en camino, consulta los horarios de las actividades a continuación. Al llegar, muestra el QR de tu entrada y tu cédula.'
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
      preheader: 'Consulta el lugar, la apertura de puertas y los horarios de las actividades.',
      title: tpl.headline,
      paragraphs: [
        `Hola ${escapeHtml(firstName(order))}, tienes confirmada la entrada <strong>#${escapeHtml(order.ticket_number)}</strong> para <strong>${escapeHtml(cfg.event_title)}</strong>.`,
        tpl.intro,
        fullEventAccess
      ],
      rowsTitle: 'Fecha, lugar y horarios del evento',
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

  const mode = mailDeliveryMode(s);
  if (mode === 'mailpit') {
    result.smtp.message = 'Mailpit es un buzón de pruebas. Configura un servidor SMTP real para entregar correos a los compradores.';
  }
  if (mode === 'smtp') {
    try {
      await getTransporter(s).transporter.verify();
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
      ? { ok: true, message: `El servidor SMTP aceptó el correo de prueba para ${to}. Comprueba si llegó a tu buzón.${sent.imapSaved ? ' Se guardó una copia en Enviados.' : ''}${sent.errorMessage ? ` ${sent.errorMessage}` : ''}` }
      : { ok: false, message: `No se pudo enviar el correo de prueba: ${sent.errorMessage}` };
  }

  return result;
}

const retryableStatuses = new Set(['ERROR', 'SIMULATED_OUTBOX']);
const pendingRetries = new Set();
// PAYMENT_APPROVED was a separate "pago aceptado" notice; the ticket email now covers it, so old
// undelivered ones are not resent.
const orderEmailStates = {
  PAYMENT_RECEIVED: 'PENDING',
  TICKET_APPROVED: 'APPROVED',
  PAYMENT_REJECTED: 'REJECTED'
};

async function retryOrderEmail(logId) {
  const log = db.prepare('SELECT * FROM email_logs WHERE id = ?').get(logId);
  if (!log?.order_id || !retryableStatuses.has(log.status) || !Object.hasOwn(orderEmailStates, log.type)) {
    return { ok: false, message: 'Este correo no está disponible para reenvío.' };
  }
  if (mailDeliveryMode() !== 'smtp') {
    return { ok: false, message: 'Configura y prueba un servidor SMTP real antes de reenviar.' };
  }
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(log.order_id);
  if (!order || order.status !== orderEmailStates[log.type]) {
    return { ok: false, message: 'El estado del pago cambió. Este aviso ya no corresponde.' };
  }
  const latest = db.prepare('SELECT id FROM email_logs WHERE order_id = ? AND type = ? ORDER BY id DESC LIMIT 1').get(log.order_id, log.type);
  const key = `${log.order_id}:${log.type}`;
  if (latest.id !== log.id || pendingRetries.has(key)) {
    return { ok: false, message: 'Este correo ya tiene un intento posterior o un reenvío en curso.' };
  }
  pendingRetries.add(key);
  try {
    let result;
    switch (log.type) {
      case 'PAYMENT_RECEIVED':
        result = await sendPaymentSubmittedEmail(order);
        break;
      case 'PAYMENT_REJECTED':
        result = await sendPaymentRejectedEmail(order, order.admin_notes);
        break;
      case 'TICKET_APPROVED': {
        const filename = /^\/storage\/tickets\/([\w-]+\.pdf)$/.exec(order.pdf_path || '')?.[1];
        const pdfPath = filename && path.join(__dirname, '..', 'storage', 'tickets', filename);
        if (!pdfPath || !fs.existsSync(pdfPath)) {
          return { ok: false, message: 'No se encontró el PDF de la entrada.' };
        }
        result = await sendTicketEmail(order, pdfPath, order.pdf_path);
        break;
      }
    }
    return result.status === 'SENT_SMTP'
      ? { ok: true, message: 'El servidor SMTP aceptó el reenvío.' }
      : { ok: false, message: result.errorMessage || 'El correo sigue pendiente de envío real.' };
  } finally {
    pendingRetries.delete(key);
  }
}

// Latest notice of each order and type that never reached the buyer and still matches the order's state
// (for example, "en verificación" is not resent once the payment was approved).
function undeliveredOrderEmails() {
  return db.prepare(`
    SELECT l.id, l.type, l.status, o.status AS order_status
    FROM email_logs l JOIN orders o ON o.id = l.order_id
    WHERE l.id IN (SELECT MAX(id) FROM email_logs WHERE order_id IS NOT NULL GROUP BY order_id, type)
    ORDER BY l.id
  `).all().filter(row => retryableStatuses.has(row.status) && orderEmailStates[row.type] === row.order_status);
}

// Resends every undelivered notice in the order it was first produced.
async function retryUndeliveredOrderEmails() {
  let sent = 0;
  const failed = [];
  for (const row of undeliveredOrderEmails()) {
    const result = await retryOrderEmail(row.id);
    if (result.ok) sent++;
    else failed.push({ id: row.id, type: row.type, message: result.message });
  }
  return { sent, failed };
}

module.exports = {
  sendPaymentSubmittedEmail,
  sendTicketEmail,
  sendPaymentRejectedEmail,
  sendEventCampaignNotification,
  testMailConnections,
  htmlToText,
  mailDeliveryMode,
  retryOrderEmail,
  undeliveredOrderEmails,
  retryUndeliveredOrderEmails
};
