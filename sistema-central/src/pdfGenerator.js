const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const fs = require('node:fs');
const path = require('node:path');

const ticketsDir = path.join(__dirname, '..', 'storage', 'tickets');
if (!fs.existsSync(ticketsDir)) {
  fs.mkdirSync(ticketsDir, { recursive: true });
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

    // Clean minimalist border
    doc
      .rect(20, 20, doc.page.width - 40, doc.page.height - 40)
      .lineWidth(1)
      .strokeColor('#111111')
      .stroke();

    // Header
    doc
      .fillColor('#111111')
      .font('Helvetica-Bold')
      .fontSize(13)
      .text(eventConfig.event_title || 'EVENTO BENÉFICO - LABOR SOCIAL', 36, 38, {
        width: doc.page.width - 72,
        align: 'center'
      });

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#444444')
      .text(eventConfig.event_subtitle || 'Acceso General: Conferencias + Concierto', {
        width: doc.page.width - 72,
        align: 'center'
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
      `FECHA DEL EVENTO: ${eventConfig.event_date || 'Por definir'}   |   HORA DE INGRESO: ${eventConfig.event_entry_time || '15:30'}`,
      40,
      schedY + 2
    );
    doc.font('Helvetica').fontSize(8.5).fillColor('#222222').text(
      `• Parte 1 (Conferencias): 4:00 PM a 7:00 PM\n• Parte 2 (Concierto): A partir de las 7:00 PM (Acceso incluido a ambas actividades)`,
      40,
      schedY + 18
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
        `Ref. Bancaria Verificada: ${order.payment_reference} | Origen: ${order.source_web}\nPresente este código QR junto con su Cédula de Identidad en la entrada.`,
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
