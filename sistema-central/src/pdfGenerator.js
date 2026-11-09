const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const ticketsDir = path.join(__dirname, '..', 'storage', 'tickets');
const brandAssets = path.join(__dirname, '..', 'public', 'admin', 'brands');
const salesSources = {
  'pagina-web-1': 'Iluminando Caminos',
  'pagina-web-2': 'Hablemos de Marketing'
};
const ink = '#1c2634';
const muted = '#526173';

function formatDate(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!parts) return value || 'Por definir';
  return new Intl.DateTimeFormat('es-VE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
  }).format(new Date(Date.UTC(+parts[1], +parts[2] - 1, +parts[3])));
}

function formatTime(value) {
  const parts = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!parts) return value || '';
  const hour = Number(parts[1]);
  return `${hour % 12 || 12}:${parts[2]} ${hour >= 12 ? 'p. m.' : 'a. m.'}`;
}

function fitText(doc, value, x, y, width, height, size, minimum = 8) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const options = { width, lineGap: 1 };
  doc.fontSize(size);
  while (size > minimum && doc.heightOfString(text, options) > height) {
    size -= 0.5;
    doc.fontSize(size);
  }
  doc.text(text, x, y, { ...options, height, ellipsis: true });
}

function drawBrandHeader(doc, inset, width) {
  const middle = inset + width / 2;
  const background = doc.linearGradient(inset, 24, inset + width, 24)
    .stop(0, '#581424')
    .stop(0.5, '#35172e')
    .stop(1, '#27154e');
  doc.roundedRect(inset, 24, width, 86, 12).fill(background);
  doc.moveTo(middle, 42).lineTo(middle, 92).lineWidth(0.6).stroke('#825b78');
  doc.image(path.join(brandAssets, 'iluminando-caminos.png'), inset, 36, {
    fit: [width / 2, 62], align: 'center', valign: 'center'
  });
  doc.image(path.join(brandAssets, 'hablemos-de-marketing.png'), middle, 38, {
    fit: [width / 2, 58], align: 'center', valign: 'center'
  });
}

function createTicketDocument(order, config, qrBuffer, demo) {
  const sourceName = salesSources[order.source_web];
  const eventTitle = config.event_title || 'Encuentro por una causa';
  const doc = new PDFDocument({
    size: 'A5', margin: 0,
    info: {
      Title: demo ? 'Entrada de demostración' : `Entrada #${order.ticket_number} - ${eventTitle}`,
      Author: 'Iluminando Caminos y Hablemos de Marketing'
    }
  });
  const inset = 32;
  const width = doc.page.width - 2 * inset;

  const label = (text, x, y) => doc.font('Helvetica-Bold').fontSize(8).fillColor(muted).text(text, x, y, { lineBreak: false });
  const divider = y => doc.moveTo(inset, y).lineTo(inset + width, y).lineWidth(0.6).stroke('#dce2e9');
  const value = (text, x, y, maxWidth, height, size = 11) => {
    doc.font('Helvetica').fillColor(ink);
    fitText(doc, text, x, y, maxWidth, height, size);
  };

  drawBrandHeader(doc, inset, width);
  doc.font('Helvetica-Bold').fillColor(ink);
  fitText(doc, eventTitle, inset, 127, width, 54, 23, 14);

  doc.roundedRect(inset, 188, 169, 20, 5).fill('#f4e9ed');
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#581424')
    .text(`ENTRADA #${order.ticket_number}  /  ACCESO GENERAL`, inset + 9, 195, { lineBreak: false });
  if (demo) {
    doc.roundedRect(inset + width - 112, 188, 112, 20, 5).fill('#f5e7d0');
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#734719')
      .text('DEMO / SIN VALIDEZ', inset + width - 112, 195, { width: 112, align: 'center' });
  }
  if (sourceName) value(`Página de origen: ${sourceName}`, inset, 215, width, 12, 9);

  doc.roundedRect(inset, 235, width, 87, 10).fill('#f3f0f8');
  const eventX = inset + 14;
  const eventWidth = width - 28;
  label('FECHA E INGRESO', eventX, 246);
  value(`${formatDate(config.event_date)} · ${formatTime(config.event_entry_time || '15:30')}`, eventX, 259, eventWidth, 16);
  value(config.event_location || 'Lugar por definir', eventX, 277, eventWidth, 21, 10);
  value(`Conferencias ${formatTime(config.conference_start || '16:00')} a ${formatTime(config.conference_end || '19:00')} · Concierto ${formatTime(config.concert_start || '19:00')}`, eventX, 301, eventWidth, 18, 9);

  label('TITULAR', inset, 337);
  doc.font('Helvetica-Bold').fillColor(ink);
  fitText(doc, order.buyer_name, inset, 350, width, 33, 16, 10);
  label('IDENTIDAD', inset, 387);
  label('TELÉFONO', inset + width / 2, 387);
  value(order.buyer_cedula, inset, 399, width / 2 - 10, 17);
  value(order.buyer_phone, inset + width / 2, 399, width / 2, 17);
  label('CORREO', inset, 418);
  value(order.buyer_email, inset, 430, width, 25, 10);

  divider(458);
  const qrSize = 106;
  doc.image(qrBuffer, inset + width - qrSize, 460, { width: qrSize, height: qrSize });
  const scanWidth = width - qrSize - 14;
  doc.font('Helvetica-Bold').fontSize(15).fillColor(ink)
    .text(demo ? 'QR de muestra' : 'Código de acceso', inset, 475, { width: scanWidth });
  value(demo ? 'Datos ficticios. Este código es una muestra del formato de la entrada.' : 'Muestra el QR y tu cédula al personal de ingreso. La entrada incluye ambos bloques.', inset, 498, scanWidth, 37, 10);
  doc.font('Courier').fillColor(ink);
  fitText(doc, order.verification_token, inset, 540, scanWidth, 22, 8, 7);

  divider(568);
  value(
    demo ? 'Pago de muestra · Ref. 000000'
      : `Pago verificado · ${order.payment_bank ? `${order.payment_bank} · ` : ''}Ref. ${order.payment_reference}`,
    inset, 577, width, 16, 8
  );
  return doc;
}

const qrOptions = { errorCorrectionLevel: 'H', margin: 4, width: 360 };

async function generateTicketPdf(order, eventConfig, baseUrl = 'http://localhost:4000') {
  const filename = `ENTRADA-${order.ticket_number}-ORD${order.id}.pdf`;
  const pdfFullPath = path.join(ticketsDir, filename);
  const verificationUrl = `${baseUrl.replace(/\/$/, '')}/verify/${encodeURIComponent(order.verification_token)}`;
  const qrBuffer = await QRCode.toBuffer(verificationUrl, qrOptions);
  const doc = createTicketDocument(order, eventConfig, qrBuffer, false);
  fs.mkdirSync(ticketsDir, { recursive: true });
  const write = pipeline(doc, fs.createWriteStream(pdfFullPath));
  doc.end();
  await write;
  return {
    pdfFullPath,
    pdfRelativeUrl: `/storage/tickets/${filename}`,
    qrDataUrl: `data:image/png;base64,${qrBuffer.toString('base64')}`,
    verificationUrl
  };
}

async function generateDemoTicketPdf(source, eventConfig) {
  const sample = {
    source_web: source,
    ticket_number: '001',
    buyer_name: 'Andrea Pérez',
    buyer_cedula: 'V-00000000',
    buyer_phone: '0000-0000000',
    buyer_email: 'andrea@example.invalid',
    verification_token: 'DEMO-001'
  };
  const qrBuffer = await QRCode.toBuffer('DEMO-ENTRADA-SIN-VALIDEZ', qrOptions);
  const doc = createTicketDocument(sample, eventConfig, qrBuffer, true);
  doc.end();
  const chunks = [];
  for await (const chunk of doc) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = { generateTicketPdf, generateDemoTicketPdf };
