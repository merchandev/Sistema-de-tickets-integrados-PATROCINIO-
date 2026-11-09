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

function createTicketDocument(order, config, qrBuffer, demo) {
  const sourceName = salesSources[order.source_web];
  const eventTitle = config.event_title || 'Encuentro por una causa';
  const doc = new PDFDocument({
    // PDF coordinates are points. At 96 dpi this page renders to 1920 × 1080 px.
    size: [1440, 810], margin: 0,
    info: {
      Title: demo ? 'Entrada de demostración' : `Entrada #${order.ticket_number} - ${eventTitle}`,
      Author: 'Iluminando Caminos y Hablemos de Marketing'
    }
  });
  // Draw on a 960 × 540 grid so the layout and typography share one scale.
  doc.scale(1.5);
  const paper = '#eeebf0';
  const cream = '#faf7f1';
  const light = '#fff9f3';
  const lavender = '#e4d5eb';
  const lime = '#def45b';
  const perforation = 673;
  const stubX = 699;
  const stubWidth = 204;

  const label = (text, x, y, color = muted) => {
    doc.font('Helvetica-Bold').fontSize(10).fillColor(color)
      .text(text, x, y, { lineBreak: false, characterSpacing: 0.7 });
  };
  const value = (text, x, y, width, height, size = 13, color = ink) => {
    doc.font('Helvetica').fillColor(color);
    fitText(doc, text, x, y, width, height, size);
  };

  doc.rect(0, 0, 960, 540).fill(paper);
  doc.roundedRect(30, 39, 900, 466, 19).fill('#dbd4df');
  doc.save().roundedRect(30, 34, 900, 466, 19).clip();

  const background = doc.linearGradient(30, 34, 673, 480)
    .stop(0, '#5c1830')
    .stop(0.56, '#45194f')
    .stop(1, '#29225e');
  doc.rect(30, 34, 900, 466).fill(background);
  doc.save().strokeOpacity(0.24).lineWidth(1.1);
  doc.moveTo(370, 34).bezierCurveTo(462, 131, 576, 44, 674, 122).stroke('#e094cb');
  doc.moveTo(404, 34).bezierCurveTo(505, 108, 576, 19, 674, 102).stroke('#e094cb');
  doc.moveTo(457, 34).bezierCurveTo(530, 77, 609, 8, 674, 74).stroke('#e094cb');
  doc.restore();
  doc.rect(perforation, 34, 257, 466).fill(cream);
  doc.restore();

  doc.save().lineWidth(1.2).dash(3, { space: 5 })
    .moveTo(perforation + 1, 49).lineTo(perforation + 1, 485).stroke('#a490a6').restore();
  doc.circle(perforation, 34, 12).fill(paper);
  doc.circle(perforation, 500, 12).fill(paper);

  doc.image(path.join(brandAssets, 'iluminando-caminos.png'), 58, 55, {
    fit: [64, 62], align: 'center', valign: 'center'
  });
  doc.moveTo(134, 66).lineTo(134, 107).lineWidth(0.7).stroke('#b488ae');
  doc.image(path.join(brandAssets, 'hablemos-de-marketing-blanco.png'), 147, 57, {
    fit: [72, 58], align: 'center', valign: 'center'
  });

  label('CONFERENCIAS + CONCIERTO', 60, 136, lime);
  doc.font('Helvetica-Bold').fillColor(light);
  fitText(doc, eventTitle, 57, 157, 584, 107, 44, 25);

  doc.moveTo(60, 270).lineTo(641, 270).lineWidth(0.8).stroke('#896887');
  label('FECHA E INGRESO', 60, 281, lavender);
  value(`${formatDate(config.event_date)} · ${formatTime(config.event_entry_time || '15:30')}`, 60, 297, 300, 23, 14, light);
  value(config.event_location || 'Lugar por definir', 60, 321, 300, 26, 12, light);
  label('HORARIOS', 376, 281, lavender);
  value(`Conferencias · ${formatTime(config.conference_start || '16:00')} a ${formatTime(config.conference_end || '19:00')}`, 376, 297, 265, 20, 13, light);
  value(`Concierto · ${formatTime(config.concert_start || '19:00')}`, 376, 321, 265, 20, 13, light);

  doc.save().fillOpacity(0.14).roundedRect(59, 354, 582, 115, 11).fill('#fff').restore();
  label('TITULAR', 74, 365, lavender);
  doc.font('Helvetica-Bold').fillColor(light);
  fitText(doc, order.buyer_name, 74, 381, 549, 37, 22, 11);
  label('IDENTIDAD', 74, 421, lavender);
  label('TELÉFONO', 206, 421, lavender);
  label('CORREO', 342, 421, lavender);
  value(order.buyer_cedula, 74, 437, 120, 24, 13, light);
  value(order.buyer_phone, 206, 437, 124, 24, 13, light);
  value(order.buyer_email, 342, 437, 281, 26, 12, light);
  if (sourceName) value(`Página de origen: ${sourceName}`, 60, 480, 581, 15, 10, lavender);

  label('ACCESO GENERAL', stubX, 63);
  doc.font('Helvetica-Bold').fillColor('#45194f');
  fitText(doc, `#${order.ticket_number}`, stubX - 2, 83, stubWidth, 65, 55, 34);
  doc.moveTo(stubX, 152).lineTo(stubX + stubWidth, 152).lineWidth(0.8).stroke('#d7ccd6');

  const qrSize = 174;
  const qrX = stubX + (stubWidth - qrSize) / 2;
  doc.roundedRect(qrX - 3, 163, qrSize + 6, qrSize + 6, 8).fill('#fff');
  doc.image(qrBuffer, qrX, 166, { width: qrSize, height: qrSize });
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#45194f')
    .text(demo ? 'DEMO / SIN VALIDEZ' : 'Escanea para ingresar', stubX, 355, { width: stubWidth, align: 'center' });
  doc.font('Helvetica').fontSize(10).fillColor(muted)
    .text(demo ? 'QR de muestra' : 'Presenta también tu cédula.', stubX, 375, { width: stubWidth, align: 'center' });
  doc.font('Courier').fillColor(ink);
  fitText(doc, order.verification_token, stubX, 394, stubWidth, 25, 8, 7);

  doc.moveTo(stubX, 426).lineTo(stubX + stubWidth, 426).lineWidth(0.8).stroke('#d7ccd6');
  label(demo ? 'PAGO DE MUESTRA' : 'PAGO VERIFICADO', stubX, 440);
  value(`Ref. ${demo ? '000000' : order.payment_reference}`, stubX, 454, stubWidth, 16, 11);
  if (order.payment_bank) value(order.payment_bank, stubX, 471, stubWidth, 23, 10);

  const credit = 'Desarrollado por Espressivo Venezuela';
  doc.font('Helvetica').fontSize(9).fillColor(muted);
  doc.text(credit, 930 - doc.widthOfString(credit), 518, { lineBreak: false });
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
