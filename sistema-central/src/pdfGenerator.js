const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const ticketsDir = path.join(__dirname, '..', 'storage', 'tickets');
const brands = {
  'pagina-web-1': { name: 'Iluminando Caminos', accent: '#681b2a' },
  'pagina-web-2': { name: 'Hablemos de Marketing', accent: '#5221b5' }
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

function createTicketDocument(order, config, qrBuffer, demo) {
  const brand = brands[order.source_web] || brands['pagina-web-1'];
  const eventTitle = config.event_title || 'Encuentro por una causa';
  const doc = new PDFDocument({
    size: 'A5', margin: 0,
    info: { Title: demo ? 'Entrada de demostración' : `Entrada #${order.ticket_number} - ${eventTitle}`, Author: brand.name }
  });
  const inset = 32;
  const width = doc.page.width - 2 * inset;

  const label = (text, x, y) => doc.font('Helvetica-Bold').fontSize(8).fillColor(muted).text(text, x, y, { lineBreak: false });
  const divider = y => doc.moveTo(inset, y).lineTo(inset + width, y).lineWidth(0.6).stroke('#dce2e9');
  const value = (text, x, y, maxWidth, height, size = 11) => {
    doc.font('Helvetica').fillColor(ink);
    fitText(doc, text, x, y, maxWidth, height, size);
  };

  doc.rect(0, 0, doc.page.width, 6).fill(brand.accent);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(brand.accent).text(brand.name, inset, 31, { lineBreak: false });
  if (demo) {
    doc.roundedRect(inset + width - 112, 24, 112, 23, 6).fill('#f5e7d0');
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#734719')
      .text('DEMO / SIN VALIDEZ', inset + width - 112, 32, { width: 112, align: 'center' });
  }

  doc.font('Helvetica-Bold').fillColor(ink);
  fitText(doc, eventTitle, inset, 57, width, 55, 23, 14);
  label(`ENTRADA #${order.ticket_number}  /  ACCESO GENERAL`, inset, 120);

  doc.roundedRect(inset, 141, width, 100, 12).fill('#f1f4f8');
  const eventX = inset + 14;
  const eventWidth = width - 28;
  label('FECHA E INGRESO', eventX, 153);
  value(`${formatDate(config.event_date)} · ${formatTime(config.event_entry_time || '15:30')}`, eventX, 167, eventWidth, 18);
  value(config.event_location || 'Lugar por definir', eventX, 188, eventWidth, 21, 10);
  value(`Conferencias ${formatTime(config.conference_start || '16:00')} a ${formatTime(config.conference_end || '19:00')} · Concierto ${formatTime(config.concert_start || '19:00')}`, eventX, 212, eventWidth, 22, 9);

  label('TITULAR', inset, 259);
  doc.font('Helvetica-Bold').fillColor(ink);
  fitText(doc, order.buyer_name, inset, 273, width, 41, 17, 11);
  label('IDENTIDAD', inset, 319);
  label('TELÉFONO', inset + width / 2, 319);
  value(order.buyer_cedula, inset, 333, width / 2 - 10, 18);
  value(order.buyer_phone, inset + width / 2, 333, width / 2, 18);
  label('CORREO', inset, 358);
  value(order.buyer_email, inset, 372, width, 31, 10);

  divider(412);
  const qrSize = 114;
  doc.image(qrBuffer, inset + width - qrSize, 421, { width: qrSize, height: qrSize });
  const scanWidth = width - qrSize - 14;
  doc.font('Helvetica-Bold').fontSize(15).fillColor(ink)
    .text(demo ? 'QR de muestra' : 'Código de acceso', inset, 433, { width: scanWidth });
  value(demo ? 'Datos ficticios. Este código es una muestra del formato de la entrada.' : 'Muestra el QR y tu cédula al personal de ingreso. La entrada incluye ambos bloques.', inset, 459, scanWidth, 42, 10);
  doc.font('Courier').fillColor(ink);
  fitText(doc, order.verification_token, inset, 509, scanWidth, 28, 8, 7);

  divider(550);
  value(
    demo ? 'Pago de muestra · Ref. 000000'
      : `Pago verificado · ${order.payment_bank ? `${order.payment_bank} · ` : ''}Ref. ${order.payment_reference}`,
    inset, 561, width, 20, 8
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
