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
const ink = '#181619';
const wine = '#440C12';
const deepWine = '#220408';
const night = '#0B0716';
const violet = '#5B21D6';
const gold = '#E5C384';
const lime = '#A8FF00';
const pink = '#FF72B5';

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
    // PDF coordinates are points. At 96 dpi this page renders to 1080 × 1920 px.
    size: [810, 1440], margin: 0,
    info: {
      Title: demo ? 'Entrada de demostración' : `Entrada #${order.ticket_number} - ${eventTitle}`,
      Author: 'Iluminando Caminos y Hablemos de Marketing'
    }
  });
  // Draw on a 540 × 960 grid so the layout and typography share one scale.
  doc.scale(1.5);
  const light = '#fff';
  const perforation = 302;
  const stubX = 255;
  const stubWidth = 225;
  const qrX = 54;
  const qrY = 59;
  const qrSize = 178;

  const label = (text, x, y, color = wine) => {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(color)
      .text(text, x, y, { lineBreak: false, characterSpacing: 0.7 });
  };
  const value = (text, x, y, width, height, size = 14, color = ink) => {
    doc.font('Helvetica').fillColor(color);
    fitText(doc, text, x, y, width, height, size);
  };

  // White page; the pass keeps its colours and casts a soft shadow
  doc.rect(0, 0, 540, 960).fill(light);
  doc.save().fillOpacity(0.14).roundedRect(30, 39, 480, 882, 19).fill(ink).restore();
  doc.save().roundedRect(30, 34, 480, 882, 19).clip();

  const background = doc.linearGradient(30, perforation, 510, 916)
    .stop(0, wine)
    .stop(0.28, deepWine)
    .stop(0.62, night)
    .stop(1, violet);
  doc.rect(30, perforation, 480, 916 - perforation).fill(background);
  doc.save().strokeOpacity(0.55).lineWidth(1.1);
  doc.moveTo(290, perforation).bezierCurveTo(364, 391, 448, 319, 510, 404).stroke(pink);
  doc.moveTo(325, perforation).bezierCurveTo(388, 372, 464, 304, 510, 379).stroke(pink);
  doc.moveTo(364, perforation).bezierCurveTo(426, 351, 476, 295, 510, 354).stroke(pink);
  doc.restore();
  doc.rect(30, 34, 480, perforation - 34).fill(gold);
  doc.restore();

  doc.save().lineWidth(1.2).dash(3, { space: 5 })
    .moveTo(45, perforation - 1).lineTo(495, perforation - 1).stroke(wine).restore();
  // Ticket notches take the page colour
  doc.circle(30, perforation, 12).fill(light);
  doc.circle(510, perforation, 12).fill(light);

  doc.roundedRect(qrX - 3, qrY - 3, qrSize + 6, qrSize + 6, 9).fill('#fff');
  doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(wine)
    .text(demo ? 'DEMO / SIN VALIDEZ' : 'Escanea para ingresar', qrX, 252, { width: qrSize, align: 'center' });
  doc.font('Helvetica').fontSize(10).fillColor(ink)
    .text(demo ? 'QR de muestra' : 'Presenta también tu cédula.', qrX, 270, { width: qrSize, align: 'center' });

  label('ACCESO A TODO EL EVENTO', stubX, 61);
  doc.font('Helvetica-Bold').fillColor(deepWine);
  fitText(doc, `#${order.ticket_number}`, stubX - 2, 84, stubWidth, 83, 67, 39);
  doc.save().strokeOpacity(0.5).moveTo(stubX, 169).lineTo(stubX + stubWidth, 169).lineWidth(0.8).stroke(wine).restore();
  label('CÓDIGO DE ENTRADA', stubX, 183);
  doc.font('Courier').fillColor(ink);
  fitText(doc, order.verification_token, stubX, 200, stubWidth, 26, 9, 7);

  label(demo ? 'PAGO DE MUESTRA' : 'PAGO VERIFICADO', stubX, 231);
  value(`Ref. ${demo ? '000000' : order.payment_reference}`, stubX, 248, stubWidth, 17, 11);
  if (order.payment_bank) value(order.payment_bank, stubX, 267, stubWidth, 26, 10);

  doc.image(path.join(brandAssets, 'iluminando-caminos.png'), 59, 325, {
    fit: [67, 65], align: 'center', valign: 'center'
  });
  doc.moveTo(139, 335).lineTo(139, 380).lineWidth(0.7).stroke(gold);
  doc.image(path.join(brandAssets, 'hablemos-de-marketing-blanco.png'), 153, 327, {
    fit: [76, 61], align: 'center', valign: 'center'
  });

  label('CONFERENCIAS + CONCIERTO', 60, 407, lime);
  doc.font('Helvetica-Bold').fillColor(light);
  fitText(doc, eventTitle, 58, 431, 422, 112, 36, 23);

  doc.moveTo(60, 553).lineTo(480, 553).lineWidth(0.8).stroke(gold);
  label('FECHA E INGRESO', 60, 569, gold);
  value(`${formatDate(config.event_date)} · ${formatTime(config.event_entry_time || '15:00')}`, 60, 586, 420, 22, 15, light);
  value(config.event_location || 'Lugar por definir', 60, 609, 420, 30, 14, light);

  label('HORARIOS', 60, 645, gold);
  value(`Conferencias · ${formatTime(config.conference_start || '16:00')} a ${formatTime(config.conference_end || '19:00')}`, 60, 662, 248, 35, 13, light);
  value(`Concierto · ${formatTime(config.concert_start || '19:00')}`, 320, 662, 160, 35, 13, light);

  doc.save().fillOpacity(0.4).roundedRect(59, 704, 422, 175, 11).fill(night).restore();
  label('TITULAR', 75, 720, gold);
  doc.font('Helvetica-Bold').fillColor(light);
  fitText(doc, order.buyer_name, 75, 737, 390, 42, 24, 12);
  label('IDENTIDAD', 75, 787, gold);
  label('TELÉFONO', 270, 787, gold);
  value(order.buyer_cedula, 75, 804, 175, 20, 14, light);
  value(order.buyer_phone, 270, 804, 195, 20, 14, light);
  label('CORREO', 75, 833, gold);
  value(order.buyer_email, 75, 850, 390, 24, 13, light);
  if (sourceName) value(`Página de origen: ${sourceName}`, 60, 892, 420, 16, 11, light);

  const credit = 'Desarrollado por Espressivo Venezuela';
  doc.font('Helvetica').fontSize(10).fillColor(wine);
  const creditX = 510 - doc.widthOfString(credit);
  const footerLogoSize = 28;
  doc.image(path.join(brandAssets, 'espressivo-venezuela.png'), creditX - footerLogoSize - 8, 926, {
    width: footerLogoSize, height: footerLogoSize
  });
  doc.text(credit, creditX, 934, { lineBreak: false });
  return doc;
}

const qrOptions = { errorCorrectionLevel: 'H', margin: 4, width: 360 };

async function generateTicketPdf(order, eventConfig, baseUrl = 'http://localhost:4000', outputDir = ticketsDir, revision = '') {
  const filename = `ENTRADA-${order.ticket_number}-ORD${order.id}${revision ? `-${revision}` : ''}.pdf`;
  const pdfFullPath = path.join(outputDir, filename);
  const verificationUrl = `${baseUrl.replace(/\/$/, '')}/verify/${encodeURIComponent(order.verification_token)}`;
  const qrBuffer = await QRCode.toBuffer(verificationUrl, qrOptions);
  const doc = createTicketDocument(order, eventConfig, qrBuffer, false);
  fs.mkdirSync(outputDir, { recursive: true });
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
    verification_token: 'Espressivo-001-DEMO'
  };
  const qrBuffer = await QRCode.toBuffer('DEMO-ENTRADA-SIN-VALIDEZ', qrOptions);
  const doc = createTicketDocument(sample, eventConfig, qrBuffer, true);
  doc.end();
  const chunks = [];
  for await (const chunk of doc) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function correctedTicketPdfFilename(order) {
  const filename = /^\/storage\/tickets\/(ENTRADA-\d{3}-ORD\d+-[a-f0-9-]{36}\.pdf)$/.exec(order?.pdf_path || '')?.[1];
  return filename?.startsWith(`ENTRADA-${order.ticket_number}-ORD${order.id}-`) ? filename : null;
}

module.exports = { generateTicketPdf, generateDemoTicketPdf, correctedTicketPdfFilename };
