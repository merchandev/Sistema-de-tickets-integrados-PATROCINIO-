const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const fs = require('node:fs');
const path = require('node:path');

const ticketsDir = path.join(__dirname, '..', 'storage', 'tickets');
if (!fs.existsSync(ticketsDir)) {
  fs.mkdirSync(ticketsDir, { recursive: true });
}

// Header name and colour after the page the ticket was bought from.
const BRANDS = {
  'pagina-web-1': { name: 'ILUMINANDO CAMINOS', color: '#650b10' },
  'pagina-web-2': { name: 'HABLEMOS DE MARKETING', color: '#5b21d6' }
};

function formatDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) return value || 'Por definir';
  return new Intl.DateTimeFormat('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
}
function formatTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return value || '';
  const h = parseInt(m[1], 10);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

/**
 * Generates a clean, minimal PDF ticket with an embedded cryptographic QR code.
 * Returns { pdfFullPath, pdfRelativeUrl, qrDataUrl, verificationUrl }
 */
async function generateTicketPdf(order, eventConfig, baseUrl = 'http://localhost:4000') {
  const filename = `ENTRADA-${order.ticket_number}-ORD${order.id}.pdf`;
  const pdfFullPath = path.join(ticketsDir, filename);
  const pdfRelativeUrl = `/storage/tickets/${filename}`;

  const verificationUrl = `${baseUrl.replace(/\/$/, '')}/verify/${encodeURIComponent(order.verification_token)}`;

  // Generate QR code buffer & Data URL encoding the verification URL (which contains the unique token)
  const qrBuffer = await QRCode.toBuffer(verificationUrl, {
    errorCorrectionLevel: 'H',
    margin: 1,
    width: 220,
    color: {
      dark: '#000000',
      light: '#FFFFFF'
    }
  });

  const qrDataUrl = await QRCode.toDataURL(verificationUrl, {
    errorCorrectionLevel: 'H',
    margin: 1,
    width: 220
  });

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A5',
      margin: 32,
      info: {
        Title: `Entrada #${order.ticket_number} - ${eventConfig.event_title}`,
        Author: 'Sistema Central de Entradas'
      }
    });

    const stream = fs.createWriteStream(pdfFullPath);
    doc.pipe(stream);

    const brand = BRANDS[order.source_web] || BRANDS['pagina-web-1'];

    // Clean minimalist border with the page's colour
    doc
      .rect(20, 20, doc.page.width - 40, doc.page.height - 40)
      .lineWidth(1.2)
      .strokeColor(brand.color)
      .stroke();

    // Header
    doc
      .fillColor(brand.color)
      .font('Helvetica-Bold')
      .fontSize(8)
      .text(brand.name, 36, 30, {
        width: doc.page.width - 72,
        align: 'center',
        characterSpacing: 1.5
      });

    doc
      .fillColor('#111111')
      .font('Helvetica-Bold')
      .fontSize(12)
      .text(eventConfig.event_title || 'EVENTO BENÉFICO - LABOR SOCIAL', 36, 44, {
        width: doc.page.width - 72,
        align: 'center',
        height: 30,
        ellipsis: true
      });

    // Divider line
    doc
      .moveTo(36, 82)
      .lineTo(doc.page.width - 36, 82)
      .lineWidth(0.5)
      .strokeColor('#CCCCCC')
      .stroke();

    // Ticket Number Box
    doc
      .font('Helvetica-Bold')
      .fontSize(22)
      .fillColor('#000000')
      .text(`ENTRADA #${order.ticket_number}`, 36, 94, {
        width: doc.page.width - 72,
        align: 'center'
      });

    // Buyer details
    const startY = 132;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#555555').text('TITULAR DE LA ENTRADA:', 40, startY);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000000').text(order.buyer_name, 40, startY + 13);

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#555555').text('CÉDULA DE IDENTIDAD:', 40, startY + 34);
    doc.font('Helvetica').fontSize(11).fillColor('#000000').text(order.buyer_cedula, 40, startY + 47);

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#555555').text('TELÉFONO / CORREO:', 210, startY + 34);
    doc.font('Helvetica').fontSize(9).fillColor('#000000').text(`${order.buyer_phone}\n${order.buyer_email}`, 210, startY + 47);

    // Event Schedule Summary
    const schedY = startY + 76;
    doc
      .moveTo(36, schedY - 6)
      .lineTo(doc.page.width - 36, schedY - 6)
      .lineWidth(0.5)
      .strokeColor('#CCCCCC')
      .stroke();

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111111').text(
      `${formatDate(eventConfig.event_date).toUpperCase()}   |   INGRESO: ${formatTime(eventConfig.event_entry_time || '15:30')}`,
      40,
      schedY + 2,
      { width: doc.page.width - 80 }
    );
    doc.font('Helvetica').fontSize(8.5).fillColor('#222222').text(
      `${eventConfig.event_location || ''}\nConferencia: ${formatTime(eventConfig.conference_start || '16:00')} a ${formatTime(eventConfig.conference_end || '19:00')}  ·  Concierto: desde las ${formatTime(eventConfig.concert_start || '19:00')} (acceso incluido a ambas)`,
      40,
      schedY + 15,
      { width: doc.page.width - 80 }
    );

    // QR Code centered
    const qrSize = 155;
    const qrX = (doc.page.width - qrSize) / 2;
    const qrY = schedY + 50;

    doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });

    // Token and Verification footer
    const tokenY = qrY + qrSize + 8;
    doc
      .font('Courier-Bold')
      .fontSize(8.5)
      .fillColor('#000000')
      .text(`TOKEN ÚNICO: ${order.verification_token}`, 36, tokenY, {
        width: doc.page.width - 72,
        align: 'center'
      });

    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor('#555555')
      .text(
        `Pago verificado: ${order.payment_bank ? `${order.payment_bank} · ` : ''}Ref. ${order.payment_reference}\nPresente este código QR junto con su Cédula de Identidad en la entrada.`,
        36,
        tokenY + 15,
        {
          width: doc.page.width - 72,
          align: 'center'
        }
      );

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return {
    pdfFullPath,
    pdfRelativeUrl,
    qrDataUrl,
    verificationUrl
  };
}

module.exports = {
  generateTicketPdf
};
