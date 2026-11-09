const fs = require('node:fs');
const assert = require('node:assert/strict');
const {calculateVes} = require('./sistema-central/src/money');
const env = Object.fromEntries(fs.readFileSync('.env.docker','utf8').trim().split(/\r?\n/).map(l=>l.split('=')));
const auth = 'Basic '+Buffer.from(env.ADMIN_USER+':'+env.ADMIN_PASSWORD).toString('base64');
async function request(base,route,body,admin=false) {
  const res=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(admin?{Authorization:auth}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,data:await res.json()};
}
async function run() {
  const central='http://localhost:4000';
  const refreshed=await request(central,'/api/admin/bcv/refresh',{},true);
  assert.equal(refreshed.data.bcv.success,true,JSON.stringify(refreshed.data));
  assert.equal(refreshed.data.bcv.sourceUrl,'https://www.bcv.org.ve/');
  const rate=refreshed.data.bcv.rate;
  assert.equal(refreshed.data.publicConfig.bcv_mode,'auto','Configurar modo automatico para esta prueba');
  const expected=calculateVes(5,rate);
  console.log('OK: Consulta directa BCV con HTTPS validado',refreshed.data.bcv);
  assert.equal((await request(central,'/api/public/tickets/lock',{ticket_number:'250',session_id:'spoof-source-session',source_web:'pagina-web-1'})).status,403);
  const purchases=[];
  for(const index of [1,2]) {
    const site=`http://localhost:${3000+index}`;
    const state=(await request(site,'/api/public/state')).data;
    assert.equal(state.config.bcv_rate,rate); assert.equal(state.config.ticket_price_ves,expected);
    const ticket=state.tickets.find(t=>t.status==='AVAILABLE').ticket_number;
    const session=`bcv-origin-test-${index}-${Date.now()}`;
    const incorrectSource=index===1?'pagina-web-2':'pagina-web-1';
    const lock=await request(site,'/api/public/tickets/lock',{ticket_number:ticket,session_id:session,source_web:incorrectSource});
    assert.equal(lock.status,200,JSON.stringify(lock.data));
    assert.equal(lock.data.ticket.locked_by_source,`pagina-web-${index}`);
    assert.equal(lock.data.pricing.amount_ves,expected);
    let id;
    try {
      const order=await request(site,'/api/public/orders',{ticket_number:ticket,session_id:session,source_web:incorrectSource,buyer_first_name:'Prueba',buyer_last_name:'Origen BCV',payment_bank:'Bancamiga (0172)',buyer_cedula:'V-12345678',buyer_email:'bcv-origen@socials.test',buyer_phone:'04121234567',payment_phone:'04121234567',payment_reference:`BCV-${index}-${Date.now()}`,screenshot_base64:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='});
      assert.equal(order.status,201,JSON.stringify(order.data));id=order.data.order.id;
      assert.equal(order.data.order.source_web,`pagina-web-${index}`);
      assert.equal(order.data.order.bcv_rate,rate);assert.equal(order.data.order.amount_ves,expected);
      const overview=(await request(central,'/api/admin/overview',undefined,true)).data;
      const stored=overview.orders.find(o=>o.id===id);
      assert.equal(stored.source_web,`pagina-web-${index}`);
      assert(overview.salesBySource[`pagina-web-${index}`].pending>=1);
      for(const source of ['pagina-web-1','pagina-web-2']) assert.equal(overview.salesBySource[source].sold,overview.orders.filter(o=>o.source_web===source&&o.status==='APPROVED').length);
      purchases.push({source:stored.source_web,ticket,orderId:id,rate:stored.bcv_rate,amount_ves:stored.amount_ves});
      console.log('OK: Monto y origen conservados desde Web',index,'hasta dashboard; origen falso del navegador ignorado.');
    } finally {
      if(id)assert.equal((await request(central,`/api/admin/orders/${id}/reject`,{reason:'Solicitud de prueba automatizada BCV/origen; sin pago real.'},true)).status,200);
      else await request(central,'/api/public/tickets/unlock',{ticket_number:ticket,session_id:session});
    }
  }
  fs.mkdirSync('output/verificacion',{recursive:true});
  fs.writeFileSync('output/verificacion/bcv-origen.json',JSON.stringify({date:new Date().toISOString(),official:refreshed.data.bcv,expected,purchases,ok:true},null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1;});
