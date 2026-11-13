const assert = require('node:assert/strict');
const fs = require('node:fs');
const {io} = require('socket.io-client');
const {PNG} = require('pngjs');
const jsQR = require('jsqr');
const env = Object.fromEntries(fs.readFileSync('.env.docker','utf8').trim().split(/\r?\n/).map(l => l.split('=')));
const auth = 'Basic ' + Buffer.from(env.ADMIN_USER + ':' + env.ADMIN_PASSWORD).toString('base64');
const central = 'http://localhost:4000';
const sites = ['http://localhost:3001','http://localhost:3002'];
const results = [];
function pass(name, detail) { results.push({name, detail, ok:true}); console.log('OK:',name, detail || ''); }
async function req(base, route, body, admin = false, method = 'POST') {
  const res = await fetch(base + route, {method:body === undefined ? 'GET' : method, headers:{...(body === undefined ? {} : {'Content-Type':'application/json'}),...(admin ? {Authorization:auth} : {})}, body:body === undefined ? undefined : JSON.stringify(body)});
  return {status:res.status, data:await res.json()};
}
const lock = (site, session) => req(site,'/api/public/tickets/lock',{session_id:session,source_web:site === sites[0] ? 'pagina-web-1' : 'pagina-web-2'});
const unlock = (number,session) => req(central,'/api/public/tickets/unlock',{ticket_number:number,session_id:session});
const payload = (number,session,site) => ({ticket_number:number, session_id:session, source_web:site, buyer_first_name:'Comprador',buyer_last_name:'de Prueba',payment_bank:'Bancamiga (0172)',buyer_cedula:'V-12345678',buyer_email:'comprador@socials.test',buyer_phone:'04121234567',payment_phone:'04121234567',payment_reference:'DOCKER-'+Date.now(),screenshot_base64:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='});
const sockets = [];
async function socket(site, sessionId) {
  const client = io(site,{transports:['websocket'],reconnection:false,query:{sessionId}}); sockets.push(client);
  await new Promise((resolve,reject) => {client.once('init:state',resolve);client.once('connect_error',reject);setTimeout(()=>reject(Error('Socket timeout')),8000).unref();});
  return client;
}
async function run() {
  fs.mkdirSync('output/verificacion',{recursive:true});
  const initial = await req(central,'/api/public/state');
  assert(!('tickets' in initial.data));
  const inventory = await req(central,'/api/admin/overview',undefined,true);
  assert.equal(inventory.data.tickets.length,250);
  assert.equal(initial.data.config.lock_duration_seconds,900);
  assert.equal(initial.data.config.ticket_price_usd,5);
  pass('250 entradas, precio USD 5 y reservas de 900 segundos');
  const used = inventory.data.tickets.filter(t=>t.status==='AVAILABLE').map(t=>t.ticket_number);
  assert(used.length >= 8,'Se requieren 8 entradas libres');
  const [expiry,one,two,regression] = used;
  const expiryLock = await lock(sites[0],'expiry-test'); assert.equal(expiryLock.status,200);
  assert.equal(expiryLock.data.ticket.ticket_number,expiry);
  const expiryUntil = expiryLock.data.ticket.locked_until;
  pass('Reserva real iniciada',expiry);
  for (const site of sites) {
    assert.equal((await fetch(site)).status,200);
    assert(!('tickets' in (await req(site,'/api/public/state')).data));
  }
  pass('Ambas webs sirven contenido y comparten la API');
  assert.equal((await fetch(central+'/api/admin/overview')).status,401);
  for (const route of ['/admin/','/storage/tickets/inexistente.pdf']) assert.equal((await fetch(central+route,{redirect:'manual'})).status,302);
  pass('Administrador, capturas y PDFs requieren autenticacion');
  const sessions = ['race-session-0', 'race-session-1'];
  const [s1,s2] = await Promise.all(sites.map((site,i)=>socket(site,sessions[i])));
  const updates = [s1,s2].map(client => new Promise(resolve=>client.once('reservation:updated',resolve)));
  const assigned = await Promise.all(sites.map((site,i)=>lock(site,sessions[i])));
  assert(assigned.every(r=>r.status===200));
  assert.deepEqual(assigned.map(r=>r.data.ticket.ticket_number).sort(),[one,two]);
  const delivered = await Promise.race([Promise.all(updates), new Promise((_,reject)=>setTimeout(()=>reject(Error('No llegaron las reservas al socket')),5000).unref())]);
  for (const [i,response] of assigned.entries()) {
    assert.equal(delivered[i].reservation.ticket_number,response.data.ticket.ticket_number);
    assert(!('tickets' in delivered[i]));
    assert.equal(response.data.ticket.locked_until-response.data.serverTime,900000);
    assert.equal((await req(sites[i],'/api/public/orders',payload(response.data.ticket.ticket_number,'intruder','pagina-web-'+(i+1)))).status,409);
    await unlock(response.data.ticket.ticket_number,sessions[i]);
  }
  pass('Asignación simultánea y única en ambas webs. Cada socket solo recibe su reserva');
  const approved = [];
  for (const [i,number] of [one,two].entries()) {
    const session = 'buyer-'+i+'-'+Date.now();
    const assignedTicket = await lock(sites[i],session);
    assert.equal(assignedTicket.status,200);
    assert.equal(assignedTicket.data.ticket.ticket_number,number);
    const order = await req(sites[i],'/api/public/orders',payload(number,session,'pagina-web-'+(i+1)));
    assert.equal(order.status,201);
    const approval = await req(central,`/api/admin/orders/${order.data.order.id}/approve`,{},true);
    assert.equal(approval.status,200);
    assert.equal(approval.data.emailResult.status,'SENT_SMTP');
    const pdf = await fetch(central+approval.data.pdfUrl,{headers:{Authorization:auth}});
    const buffer = Buffer.from(await pdf.arrayBuffer()); assert.equal(buffer.subarray(0,5).toString(),'%PDF-');
    fs.writeFileSync(`output/verificacion/entrada-${number}.pdf`,buffer);
    const png = PNG.sync.read(Buffer.from(approval.data.qrDataUrl.split(',')[1],'base64'));
    const decoded = jsQR(new Uint8ClampedArray(png.data),png.width,png.height);
    assert.equal(decoded.data,approval.data.verificationUrl);
    const token=approval.data.order.verification_token;
    assert.equal((await req(central,'/api/admin/verify-qr/'+token,undefined,true)).data.valid,true);
    const ingress=await Promise.all([req(central,`/api/admin/verify-qr/${token}/checkin`,{},true),req(central,`/api/admin/verify-qr/${token}/checkin`,{},true)]);
    assert.deepEqual(ingress.map(r=>r.status).sort(),[200,409]);
    assert.equal((await req(central,`/api/admin/orders/${order.data.order.id}/reject`,{},true)).status,400);
    approved.push(approval.data.order);
  }
  assert.notEqual(approved[0].verification_token,approved[1].verification_token);
  assert.equal((await req(central,'/api/admin/verify-qr/TK-FALSO',undefined,true)).status,404);
  pass('Compra desde ambas webs, aprobacion, PDF, QR decodificado y SMTP real a Mailpit');
  pass('QR falso rechazado e ingreso único a todo el evento incluso con escaneos simultáneos');
  assert.equal((await lock(sites[0],'regression-old')).data.ticket.ticket_number,regression);
  const old = await req(sites[0],'/api/public/orders',payload(regression,'regression-old','pagina-web-1'));
  await req(central,`/api/admin/orders/${old.data.order.id}/reject`,{},true);
  assert.equal((await lock(sites[1],'regression-new')).data.ticket.ticket_number,regression);
  const replacement=await req(sites[1],'/api/public/orders',payload(regression,'regression-new','pagina-web-2'));
  assert.equal((await req(central,`/api/admin/orders/${old.data.order.id}/approve`,{},true)).status,400);
  await req(central,`/api/admin/orders/${replacement.data.order.id}/reject`,{},true);
  pass('Orden rechazada antigua no puede apropiarse de una nueva compra');
  const quoteLock = await lock(sites[0],'price-quote');
  const quote = quoteLock.data.ticket.ticket_number;
  const cfg=(await req(central,'/api/public/state')).data.config;
  try {
    await req(central,'/api/admin/settings',{ticket_price_usd:7},true,'PUT');
    const quoted=await req(sites[0],'/api/public/orders',payload(quote,'price-quote','pagina-web-1'));
    const stored = (await req(central,'/api/admin/overview',undefined,true)).data.orders.find(o=>o.id===quoted.data.order.id);
    assert.equal(stored.amount_usd,quoteLock.data.pricing.amount_usd);
    assert.equal(stored.amount_ves,quoteLock.data.pricing.amount_ves);
    await req(central,`/api/admin/orders/${quoted.data.order.id}/reject`,{},true);
  } finally { await req(central,'/api/admin/settings',{ticket_price_usd:cfg.ticket_price_usd},true,'PUT'); }
  pass('Precio congelado durante la reserva aunque cambie la configuracion');
  for(const key of ['REMINDER_2_DAYS','REMINDER_1_DAY','REMINDER_TODAY','EVENT_STARTED']) assert.equal((await req(central,'/api/admin/notifications/send',{campaign_key:key},true)).status,200);
  const inbox=await (await fetch('http://localhost:8025/api/v1/messages')).json();
  assert(inbox.total>=12);
  pass('Las cuatro campanas SMTP llegan al buzon de pruebas',`${inbox.total} mensajes`);
  const bcv=await req(central,'/api/public/bcv');
  pass('Consulta de tasa (fuente y resultado documentados)',JSON.stringify(bcv.data.bcv));
  const manual = (await lock(sites[0],'manual-pending')).data.ticket.ticket_number;
  const pending=await req(sites[0],'/api/public/orders',payload(manual,'manual-pending','pagina-web-1'));
  assert.equal(pending.status,201);
  pass('Solicitud pendiente preparada para revision manual',`Entrada ${manual}, orden ${pending.data.order.id}`);
  console.log('Esperando vencimiento REAL de 900 segundos...',new Date(expiryUntil).toISOString());
  while(Date.now()<expiryUntil+1500) await new Promise(r=>setTimeout(r,1000));
  const expiredState=await req(central,'/api/admin/overview',undefined,true);
  assert.equal(expiredState.data.tickets.find(t=>t.ticket_number===expiry).status,'AVAILABLE');
  assert.equal((await req(sites[0],'/api/public/orders',payload(expiry,'expiry-test','pagina-web-1'))).status,409);
  assert.equal((await lock(sites[1],'after-expiry')).data.ticket.ticket_number,expiry); await unlock(expiry,'after-expiry');
  pass('Liberacion tras 900 segundos reales y reserva posterior desde la otra web');
  fs.writeFileSync('output/verificacion/resultados.json',JSON.stringify({date:new Date().toISOString(),results,approved:approved.map(o=>({id:o.id,ticket:o.ticket_number,pdf:o.pdf_path})),pending:{id:pending.data.order.id,ticket:manual}},null,2));
}
run().catch(err=>{console.error(err);process.exitCode=1;}).finally(()=>sockets.forEach(s=>s.disconnect()));
