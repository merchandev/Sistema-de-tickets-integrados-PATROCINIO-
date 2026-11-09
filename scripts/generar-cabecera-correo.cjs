// Draws the header image of the buyer emails: both logos on the gradient of the ticket PDF.
// Output: sistema-central/public/email/cabecera.jpg (1120 x 220, shown at 560 x 110).
// Run from the repository root after `npm ci` in sistema-central: node scripts/generar-cabecera-correo.cjs
const fs = require('node:fs');
const path = require('node:path');
const central = path.join(__dirname, '..', 'sistema-central');
const { createCanvas, loadImage } = require(path.join(central, 'node_modules', '@napi-rs', 'canvas'));

const W = 1120;
const H = 220;
// Same colours as the lower part of the ticket (pdfGenerator.js)
const wine = '#440C12';
const deepWine = '#220408';
const night = '#0B0716';
const violet = '#5B21D6';
const gold = '#E5C384';
const pink = '#FF72B5';

(async () => {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, W, H);
  gradient.addColorStop(0, wine);
  gradient.addColorStop(0.28, deepWine);
  gradient.addColorStop(0.62, night);
  gradient.addColorStop(1, violet);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);

  // The ticket's pink lines, entering from the right edge
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.strokeStyle = pink;
  ctx.lineWidth = 2.2;
  for (const [x0, y1, y2, y3] of [[770, 150, 20, 120], [840, 175, 30, 75], [910, 200, 40, 30]]) {
    ctx.beginPath();
    ctx.moveTo(x0, H);
    ctx.bezierCurveTo(x0 + 120, y1, x0 + 230, y2, W, y3);
    ctx.stroke();
  }
  ctx.restore();

  const brands = path.join(central, 'public', 'admin', 'brands');
  const caminos = await loadImage(fs.readFileSync(path.join(brands, 'iluminando-caminos.png')));
  const marketing = await loadImage(fs.readFileSync(path.join(brands, 'hablemos-de-marketing-blanco.png')));
  const fit = (img, maxW, maxH) => {
    const scale = Math.min(maxW / img.width, maxH / img.height);
    return { w: img.width * scale, h: img.height * scale };
  };
  const left = fit(caminos, 150, 146);
  const right = fit(marketing, 168, 134);
  const gap = 34;
  const total = left.w + gap * 2 + right.w;
  const x = (W - total) / 2;
  ctx.drawImage(caminos, x, (H - left.h) / 2, left.w, left.h);
  const dividerX = x + left.w + gap;
  ctx.strokeStyle = gold;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(dividerX, H / 2 - 50);
  ctx.lineTo(dividerX, H / 2 + 50);
  ctx.stroke();
  ctx.drawImage(marketing, dividerX + gap, (H - right.h) / 2, right.w, right.h);

  const out = path.join(central, 'public', 'email', 'cabecera.jpg');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, await canvas.encode('jpeg', 88));
  console.log(`${path.relative(process.cwd(), out)} (${fs.statSync(out).size} bytes)`);
})();
