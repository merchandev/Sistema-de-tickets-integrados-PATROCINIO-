const assert = require('node:assert/strict');
const fs = require('node:fs');
const {io} = require('socket.io-client');
const {PNG} = require('pngjs');
const jsQR = require('jsqr');
require('./verificar-cron.cjs');
const env=Object.fromEntries(fs.readFileSync('.env.docker','utf8').trim().split(/\r?\n/).map(l=>l.split('=')));
const Authorization='Basic '+Buffer.from(env.ADMIN_USER+':'+env.ADMIN_PASSWORD).toString('base64');
async function api(route,body,method='POST',extra={}) {
  const target = ['/api/public/tickets/lock', '/api/public/orders'].includes(route) ? 'http://localhost:3001' : 'http://localhost:4000';
  const res=await fetch(target+route,{method:body===undefined?'GET':method,headers:{Authorization,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,data:await res.json()};
}
async function run() {
  const report=JSON.parse(fs.readFileSync('output/verificacion/resultados.json','utf8'));
  const overview=(await api('/api/admin/overview')).data;
  for(const approved of report.approved) {
    assert.equal(overview.orders.find(o=>o.id===approved.id).status,'APPROVED');
    assert.equal((await fetch('http://localhost:4000'+approved.pdf,{headers:{Authorization}})).status,200);
    const png=PNG.sync.read(fs.readFileSync(`output/verificacion/entrada-${approved.ticket}.png`));
    const qr=jsQR(new Uint8ClampedArray(png.data),png.width,png.height);
    assert(qr && qr.data.includes('/verify/'));
    const token=qr.data.split('/verify/')[1];
    assert.equal((await api('/api/admin/verify-qr/'+token)).data.valid,true);
  }
  console.log('OK: SQLite, aprobaciones, PDFs y tokens sobreviven a recrear los contenedores. QR leidos desde las paginas PDF renderizadas.');
  const inbox=await (await fetch('http://localhost:8025/api/v1/messages')).json();
  const attachments=inbox.messages.filter(m=>m.Attachments>0);
  assert(attachments.length>=2);
  console.log('OK: Mailpit recibio al menos dos correos con archivo PDF adjunto.');
  for(const number of ['000','251','../../test']) assert.equal((await api('/api/public/tickets/lock',{ticket_number:number,session_id:'valid-test-session'})).status,400);
  console.log('OK: Numeros de entrada invalidos rechazados.');
  const ticket=overview.tickets.find(t=>t.status==='AVAILABLE').ticket_number;
  const lock=(await api('/api/public/tickets/lock',{ticket_number:ticket,session_id:'quote-reload-session'})).data;
  assert(lock.ok);
  try {
    await api('/api/admin/settings',{ticket_price_usd:6},'PUT');
    const state=await api('/api/public/state',undefined,'GET',{'X-Session-Id':'quote-reload-session'});
    const own=state.data.tickets.find(t=>t.ticket_number===ticket);
    assert.deepEqual(own.pricing,lock.pricing);
    assert.equal(own.pricing.amount_usd,5);
    assert.equal(state.data.config.ticket_price_usd,6);
    assert.equal((await api('/api/admin/settings',{secret_hmac_key:'overwrite'},'PUT')).status,400);
  } finally {
    await api('/api/admin/settings',{ticket_price_usd:5},'PUT');
    await api('/api/public/tickets/unlock',{ticket_number:ticket,session_id:'quote-reload-session'});
  }
  assert(!('secret_hmac_key' in overview.settings));
  console.log('OK: Cotizacion se conserva al recargar; configuracion no expone ni permite sobrescribir el secreto.');
  fs.writeFileSync('output/verificacion/regresiones.json',JSON.stringify({date:new Date().toISOString(),ok:true,checks:['persistence','pdf-rendered-qr','smtp-attachments','invalid-tickets','quote-reload','settings-secret','caracas-schedule-7-cases']},null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1;});
