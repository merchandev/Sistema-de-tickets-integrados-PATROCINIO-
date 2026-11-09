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
const lock = (site, number, session) => req(site,'/api/public/tickets/lock',{ticket_number:number, session_id:session,source_web:site === sites[0] ? 'pagina-web-1' : 'pagina-web-2'});
const unlock = (number,session) => req(central,'/api/public/tickets/unlock',{ticket_number:number,session_id:session});
const payload = (number,session,site) => ({ticket_number:number, session_id:session, source_web:site, buyer_first_name:'Comprador',buyer_last_name:'de Prueba',payment_bank:'Bancamiga (0172)',buyer_cedula:'V-12345678',buyer_email:'comprador@socials.test',buyer_phone:'04121234567',payment_phone:'04121234567',payment_reference:'DOCKER-'+Date.now(),screenshot_base64:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='});
const sockets = [];
async function socket(site) {
  const client = io(site,{transports:['websocket'],reconnection:false}); sockets.push(client);
  await new Promise((resolve,reject) => {client.once('init:state',resolve);client.once('connect_error',reject);setTimeout(()=>reject(Error('Socket timeout')),8000).unref();});
  return client;
}
async function run() {
  fs.mkdirSync('output/verificacion',{recursive:true});
  const initial = await req(central,'/api/public/state');
  assert.equal(initial.data.tickets.length,250);
  assert.equal(initial.data.config.lock_duration_seconds,180);
  assert.equal(initial.data.config.ticket_price_usd,5);
  pass('250 entradas, precio USD 5 y reservas de 180 segundos');
  const used = initial.data.tickets.filter(t=>t.status==='AVAILABLE').map(t=>t.ticket_number);
  assert(used.length >= 8,'Se requieren 8 entradas libres');
  const [expiry,race,one,two,regression,quote,manual] = used;
  const expiryLock = await lock(sites[0],expiry,'expiry-test'); assert.equal(expiryLock.status,200);
  const expiryUntil = expiryLock.data.ticket.locked_until;
  pass('Reserva real iniciada',expiry);
  for (const site of sites) {
    assert.equal((await fetch(site)).status,200);
    assert.equal((await req(site,'/api/public/state')).data.tickets.length,250);
  }
  pass('Ambas webs sirven contenido y comparten la API');
  for (const route of ['/api/admin/overview','/admin/','/storage/tickets/inexistente.pdf']) assert.equal((await fetch(central+route)).status,401);
  pass('Administrador, capturas y PDFs requieren autenticacion');
  const [s1,s2] = await Promise.all(sites.map(socket));
  pass('Socket.IO por WebSocket funciona desde las dos webs');
  let seen1=false,seen2=false,leak=false;
  s1.on('tickets:updated', data=>{seen1=true;if(data.tickets.some(t=>t.locked_by_session))leak=true;});
  s2.on('tickets:updated', data=>{seen2=true;if(data.tickets.some(t=>t.locked_by_session))leak=true;});
  s2.on('admin:order_created', data=>{if(data.buyer_email || data.verification_token)leak=true;});
  const races = await Promise.all(Array.from({length:100},(_,i)=>lock(sites[i%2],race,'race-session-'+i)));
  assert.equal(races.filter(r=>r.status===200).length,1);
  assert.equal(races.filter(r=>r.status===409).length,99);
  const winner = races.find(r=>r.status===200);
  assert.equal(winner.data.ticket.locked_until-winner.data.serverTime,180000);
  const publicState = await req(central,'/api/public/state');
  assert(publicState.data.tickets.every(t=>t.locked_by_session===null));
  assert.equal((await req(sites[1],'/api/public/orders',payload(race,'intruder','pagina-web-2'))).status,409);
  await unlock(race,winner.data.ticket.locked_by_session);
  assert(seen1 && seen2 && !leak);
  pass('100 solicitudes simultaneas: 1 ganadora y 99 conflictos; sin filtracion de sesiones');
  assert.equal((await req(sites[0],'/api/public/orders',payload(manual,'no-lock','pagina-web-1'))).status,409);
  pass('No se aceptan pagos sin reserva vigente');
  const approved = [];
  for (const [i,number] of [one,two].entries()) {
    const session = 'buyer-'+i+'-'+Date.now();
    assert.equal((await lock(sites[i],number,session)).status,200);
    const order = await req(sites[i],'/api/public/orders',payload(number,session,'pagina-web-'+(i+1)));
    assert.equal(order.status,201);
    assert.equal((await lock(sites[1-i],number,'steal')).status,409);
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
    for (const stage of ['conference','concert']) {
      const ingress=await Promise.all([req(central,`/api/admin/verify-qr/${token}/checkin`,{stage},true),req(central,`/api/admin/verify-qr/${token}/checkin`,{stage},true)]);
      assert.deepEqual(ingress.map(r=>r.status).sort(),[200,409]);
    }
    assert.equal((await req(central,`/api/admin/orders/${order.data.order.id}/reject`,{},true)).status,400);
    approved.push(approval.data.order);
  }
  assert.notEqual(approved[0].verification_token,approved[1].verification_token);
  assert.equal((await req(central,'/api/admin/verify-qr/TK-FALSO',undefined,true)).status,404);
  pass('Compra desde ambas webs, aprobacion, PDF, QR decodificado y SMTP real a Mailpit');
  pass('QR falso rechazado; ingreso unico en conferencias y concierto incluso con escaneos simultaneos');
  await lock(sites[0],regression,'regression-old');
  const old = await req(sites[0],'/api/public/orders',payload(regression,'regression-old','pagina-web-1'));
  await req(central,`/api/admin/orders/${old.data.order.id}/reject`,{},true);
  await lock(sites[1],regression,'regression-new');
  const replacement=await req(sites[1],'/api/public/orders',payload(regression,'regression-new','pagina-web-2'));
  assert.equal((await req(central,`/api/admin/orders/${old.data.order.id}/approve`,{},true)).status,400);
  await req(central,`/api/admin/orders/${replacement.data.order.id}/reject`,{},true);
  pass('Orden rechazada antigua no puede apropiarse de una nueva compra');
  const quoteLock = await lock(sites[0],quote,'price-quote');
  const cfg=(await req(central,'/api/public/state')).data.config;
  try {
    await req(central,'/api/admin/settings',{ticket_price_usd:7},true,'PUT');
    const quoted=await req(sites[0],'/api/public/orders',payload(quote,'price-quote','pagina-web-1'));
    assert.equal(quoted.data.order.amount_usd,quoteLock.data.pricing.amount_usd);
    assert.equal(quoted.data.order.amount_ves,quoteLock.data.pricing.amount_ves);
    await req(central,`/api/admin/orders/${quoted.data.order.id}/reject`,{},true);
  } finally { await req(central,'/api/admin/settings',{ticket_price_usd:cfg.ticket_price_usd},true,'PUT'); }
  pass('Precio congelado durante la reserva aunque cambie la configuracion');
  for(const key of ['REMINDER_2_DAYS','REMINDER_1_DAY','REMINDER_TODAY','EVENT_STARTED']) assert.equal((await req(central,'/api/admin/notifications/send',{campaign_key:key},true)).status,200);
  const inbox=await (await fetch('http://localhost:8025/api/v1/messages')).json();
  assert(inbox.total>=12);
  pass('Las cuatro campanas SMTP llegan al buzon de pruebas',`${inbox.total} mensajes`);
  const bcv=await req(central,'/api/public/bcv');
  pass('Consulta de tasa (fuente y resultado documentados)',JSON.stringify(bcv.data.bcv));
  await lock(sites[0],manual,'manual-pending');
  const pending=await req(sites[0],'/api/public/orders',payload(manual,'manual-pending','pagina-web-1'));
  assert.equal(pending.status,201);
  pass('Solicitud pendiente preparada para revision manual',`Entrada ${manual}, orden ${pending.data.order.id}`);
  console.log('Esperando vencimiento REAL de 180 segundos...',new Date(expiryUntil).toISOString());
  while(Date.now()<expiryUntil+1500) await new Promise(r=>setTimeout(r,1000));
  const expiredState=await req(sites[1],'/api/public/state');
  assert.equal(expiredState.data.tickets.find(t=>t.ticket_number===expiry).status,'AVAILABLE');
  assert.equal((await req(sites[0],'/api/public/orders',payload(expiry,'expiry-test','pagina-web-1'))).status,409);
  assert.equal((await lock(sites[1],expiry,'after-expiry')).status,200); await unlock(expiry,'after-expiry');
  pass('Liberacion tras 180 segundos reales y reserva posterior desde la otra web');
  assert(!leak);
  fs.writeFileSync('output/verificacion/resultados.json',JSON.stringify({date:new Date().toISOString(),results,approved:approved.map(o=>({id:o.id,ticket:o.ticket_number,pdf:o.pdf_path})),pending:{id:pending.data.order.id,ticket:manual}},null,2));
}
run().catch(err=>{console.error(err);process.exitCode=1;}).finally(()=>sockets.forEach(s=>s.disconnect()));
