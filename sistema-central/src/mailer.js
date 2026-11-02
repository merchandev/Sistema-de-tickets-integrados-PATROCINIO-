function escapeHtml(value) { return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
const nodemailer = require('nodemailer');
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
 * Sends an email via SMTP (or local outbox if SMTP credentials are not yet set)
 * and records the full message + attachments in `email_logs` so it can be audited in the Dashboard.
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
  const { isLiveSmtp, from, transporter } = getTransporter();
  let status = isLiveSmtp ? 'SENT_SMTP' : 'SIMULATED_OUTBOX';
  let errorMessage = null;

  try {
    await transporter.sendMail({
      from,
      to: toName ? `"${toName}" <${toEmail}>` : toEmail,
      subject,
      html,
      attachments
    });
  } catch (err) {
    status = 'ERROR';
    errorMessage = err.message;
    console.error(`[SMTP Error] Failed to send email to ${toEmail}:`, err.message);
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
    errorMessage
  };
}

/**
 * 1. Sent when buyer submits the payment verification form
 */
async function sendPaymentSubmittedEmail(order) {
  const cfg = getPublicConfig();
  const subject = `⏳ Pago en Verificación - Entrada #${order.ticket_number} (${cfg.event_title})`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 24px; color: #111827;">
      <h2 style="margin-top: 0; color: #1d4ed8;">Hemos recibido tu reporte de pago</h2>
      <p>Hola <strong>${escapeHtml(order.buyer_name)}</strong> (C.I. ${escapeHtml(order.buyer_cedula)}),</p>
      <p>Tu solicitud para la <strong>Entrada #${escapeHtml(order.ticket_number)}</strong> ha sido registrada exitosamente desde <strong>${escapeHtml(order.source_web)}</strong>.</p>
      <div style="background: #f9fafb; padding: 14px; border-radius: 6px; margin: 16px 0;">
        <p style="margin: 4px 0;"><strong>Entrada reservada:</strong> #${escapeHtml(order.ticket_number)}</p>
        <p style="margin: 4px 0;"><strong>Monto:</strong> $${order.amount_usd.toFixed(2)} USD (Bs. ${order.amount_ves.toFixed(2)} a tasa BCV ${escapeHtml(order.bcv_rate)})</p>
        <p style="margin: 4px 0;"><strong>Referencia Bancaria:</strong> ${escapeHtml(order.payment_reference)}</p>
        <p style="margin: 4px 0;"><strong>Teléfono de Pago:</strong> ${escapeHtml(order.payment_phone)}</p>
      </div>
      <p>Nuestro equipo de administración está verificando tu pago. <strong>En cuanto sea verificado, recibirás automáticamente en este mismo correo tu entrada en formato PDF con tu código QR único.</strong></p>
    </div>
  `;

  return sendSystemEmail({
    toEmail: order.buyer_email,
    toName: order.buyer_name,
    subject,
    html,
    type: 'PAYMENT_RECEIVED',
    orderId: order.id,
    ticketNumber: order.ticket_number
  });
}

/**
 * 2. Sent AUTOMATICALLY as soon as Admin approves the payment in the Dashboard.
 * Attaches the clean PDF with QR code.
 */
async function sendTicketApprovedEmail(order, pdfFullPath, pdfRelativeUrl) {
  const cfg = getPublicConfig();
  const subject = `✅ ¡Pago Verificado! Aquí tienes tu Entrada #${order.ticket_number} - ${cfg.event_title}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #16a34a; border-radius: 8px; padding: 24px; color: #111827;">
      <h2 style="margin-top: 0; color: #15803d;">¡Tu entrada #${escapeHtml(order.ticket_number)} está lista!</h2>
      <p>Hola <strong>${escapeHtml(order.buyer_name)}</strong> (C.I. ${escapeHtml(order.buyer_cedula)}),</p>
      <p>Tu pago (Referencia: <strong>${escapeHtml(order.payment_reference)}</strong>) ha sido verificado exitosamente por la administración.</p>
      <p>Adjunto a este correo encontrarás el <strong>archivo PDF oficial de tu Entrada #${escapeHtml(order.ticket_number)}</strong> con tu código QR y Token de seguridad único:</p>
      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; padding: 14px; border-radius: 6px; margin: 16px 0;">
        <p style="margin: 4px 0;"><strong>Token Único de Verificación:</strong> <code>${escapeHtml(order.verification_token)}</code></p>
        <p style="margin: 4px 0;"><strong>Fecha del Evento:</strong> ${escapeHtml(cfg.event_date)} | <strong>Hora de Ingreso:</strong> ${escapeHtml(cfg.event_entry_time)}</p>
        <p style="margin: 4px 0;"><strong>Parte 1 - Conferencias:</strong> 4:00 PM a 7:00 PM</p>
        <p style="margin: 4px 0;"><strong>Parte 2 - Concierto:</strong> A partir de las 7:00 PM (Tu entrada incluye acceso a ambas partes)</p>
      </div>
      <p style="font-size: 13px; color: #4b5563;">Recuerda presentar el PDF adjunto (en tu teléfono o impreso) junto con tu Cédula de Identidad al momento de ingresar para escanear el código QR.</p>
    </div>
  `;

  return sendSystemEmail({
    toEmail: order.buyer_email,
    toName: order.buyer_name,
    subject,
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
 * 3. Sent when Admin rejects a payment in the Dashboard.
 */
async function sendPaymentRejectedEmail(order, reason) {
  const cfg = getPublicConfig();
  const subject = `⚠️ Aviso sobre tu reporte de pago - Entrada #${order.ticket_number}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #dc2626; border-radius: 8px; padding: 24px; color: #111827;">
      <h2 style="margin-top: 0; color: #b91c1c;">No pudimos verificar tu pago para la Entrada #${escapeHtml(order.ticket_number)}</h2>
      <p>Hola <strong>${escapeHtml(order.buyer_name)}</strong>,</p>
      <p>Revisamos el soporte enviado para la referencia <strong>${escapeHtml(order.payment_reference)}</strong> y no pudo ser validado por el siguiente motivo:</p>
      <blockquote style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 12px; margin: 16px 0;">
        ${reason || 'Datos de referencia o captura no coinciden.'}
      </blockquote>
      <p>La entrada #${escapeHtml(order.ticket_number)} ha sido liberada nuevamente. Si hubo un error al cargar los datos, puedes volver a ingresar a la página y reportar los datos correctos.</p>
    </div>
  `;

  return sendSystemEmail({
    toEmail: order.buyer_email,
    toName: order.buyer_name,
    subject,
    html,
    type: 'PAYMENT_REJECTED',
    orderId: order.id,
    ticketNumber: order.ticket_number
  });
}

/**
 * 4. Sends mass event notifications to all approved buyers:
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
      subjectPrefix: '📅 ¡Faltan 2 días para el evento!',
      headline: '¡Faltan solo 2 días para nuestro encuentro!',
      intro: 'Te recordamos que faltan dos (2) días para nuestro evento benéfico. Tu entrada incluye acceso completo tanto al ciclo de Conferencias como al Concierto.'
    },
    REMINDER_1_DAY: {
      subjectPrefix: '⏰ ¡Falta 1 día! Mañana nos vemos',
      headline: '¡Mañana es el gran día! Falta 1 día',
      intro: 'Prepara tu código QR y tu cédula de identidad. Mañana te esperamos para compartir las Conferencias (4:00 PM - 7:00 PM) y el Concierto (a partir de las 7:00 PM).'
    },
    REMINDER_TODAY: {
      subjectPrefix: '🎉 ¡Es HOY! Te esperamos hoy en el evento',
      headline: '¡Llegó el día! Hoy es el evento',
      intro: `Hoy nos encontramos en ${cfg.event_location}. Recuerda que la hora de ingreso es a las ${cfg.event_entry_time}, las Conferencias inician a las 4:00 PM hasta las 7:00 PM y el Concierto arranca a las 7:00 PM.`
    },
    EVENT_STARTED: {
      subjectPrefix: '🚀 ¡YA COMENZAMOS EL EVENTO!',
      headline: '¡Ya comenzamos el evento! Te esperamos en puerta',
      intro: 'Las puertas ya están abiertas y hemos dado inicio formal al evento. Presenta tu PDF con el código QR único en la entrada para acreditar tu ingreso a las Conferencias (4:00 PM - 7:00 PM) y al Concierto (7:00 PM+).'
    }
  };

  const tpl = templates[campaignKey];
  if (!tpl) {
    throw new Error(`Tipo de notificación inválido: ${campaignKey}`);
  }

  let sentCount = 0;
  for (const order of approvedOrders) {
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #2563eb; border-radius: 8px; padding: 24px; color: #111827;">
        <h2 style="margin-top: 0; color: #1d4ed8;">${tpl.headline}</h2>
        <p>Hola <strong>${escapeHtml(order.buyer_name)}</strong> (Entrada <strong>#${escapeHtml(order.ticket_number)}</strong>),</p>
        <p>${tpl.intro}</p>
        <div style="background: #eff6ff; border: 1px solid #bfdbfe; padding: 14px; border-radius: 6px; margin: 16px 0;">
          <p style="margin: 4px 0;"><strong>Evento:</strong> ${escapeHtml(cfg.event_title)}</p>
          <p style="margin: 4px 0;"><strong>Fecha:</strong> ${escapeHtml(cfg.event_date)} | <strong>Hora de Ingreso:</strong> ${escapeHtml(cfg.event_entry_time)}</p>
          <p style="margin: 4px 0;"><strong>Conferencias:</strong> 4:00 PM a 7:00 PM</p>
          <p style="margin: 4px 0;"><strong>Concierto:</strong> A partir de las 7:00 PM (Acceso incluido)</p>
          <p style="margin: 4px 0;"><strong>Tu Entrada:</strong> #${escapeHtml(order.ticket_number)} | <strong>Token QR:</strong> <code>${escapeHtml(order.verification_token)}</code></p>
        </div>
        <p style="font-size: 13px; color: #4b5563;">Recuerda llevar tu código QR digital o impreso junto con tu Cédula de Identidad (${escapeHtml(order.buyer_cedula)}).</p>
      </div>
    `;

    await sendSystemEmail({
      toEmail: order.buyer_email,
      toName: order.buyer_name,
      subject: `${tpl.subjectPrefix} - Entrada #${order.ticket_number} (${cfg.event_title})`,
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

module.exports = {
  sendPaymentSubmittedEmail,
  sendTicketApprovedEmail,
  sendPaymentRejectedEmail,
  sendEventCampaignNotification
};
