const https = require('node:https');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const {parseBcvHtml} = require('./bcvParser');
const {updateSettings, getAllSettings} = require('./db');
const BCV_URL = 'https://www.bcv.org.ve/';
// Supply BCV's missing intermediate without disabling standard TLS validation.
const agent = new https.Agent({ca:[...tls.rootCertificates, fs.readFileSync(path.join(__dirname,'certs','sectigo-dv-r36.pem'),'utf8')], rejectUnauthorized:true});
let inFlight = null;
function fetchBcvHtml(url = BCV_URL, redirects = 0) {
  return new Promise((resolve,reject) => {
    const req = https.get(url,{agent,headers:{'User-Agent':'Mozilla/5.0 SistemaEntradas/1.0',Accept:'text/html','Accept-Language':'es-VE,es;q=0.9'}},res => {
      if ([301,302,303,307,308].includes(res.statusCode)) {
        res.resume(); const next = new URL(res.headers.location || '',url);
        if (redirects >= 3 || next.protocol !== 'https:' || !['bcv.org.ve','www.bcv.org.ve'].includes(next.hostname)) return reject(Error('Redireccion BCV no permitida'));
        return resolve(fetchBcvHtml(next.href,redirects+1));
      }
      if (res.statusCode !== 200) {res.resume(); return reject(Error(`BCV HTTP ${res.statusCode}`));}
      if (!String(res.headers['content-type']).includes('text/html')) {res.resume();return reject(Error('BCV no devolvio HTML'));}
      let html = ''; res.setEncoding('utf8');
      res.on('data',chunk => {html+=chunk;if(html.length>2*1024*1024)req.destroy(Error('HTML BCV demasiado grande'));});
      res.on('end',()=>resolve(html));res.on('error',reject);
    });
    const timer=setTimeout(()=>req.destroy(Error('Timeout consultando BCV (15s)')),15000);
    req.on('close',()=>clearTimeout(timer));req.on('error',reject);
  });
}
async function scrapeBcvRate({maxAgeMs=0}={}) {
  const settings=getAllSettings();
  if(maxAgeMs>0&&settings.bcv_source_url===BCV_URL&&settings.bcv_fetch_status==='live'&&Date.now()-Date.parse(settings.bcv_last_updated)<maxAgeMs) return {success:true,cached:true,rate:Number(settings.bcv_last_scraped_rate),source:settings.bcv_source_label,sourceUrl:BCV_URL,valueDate:settings.bcv_value_date,updatedAt:settings.bcv_last_updated};
  if(inFlight)return inFlight;
  inFlight=(async()=>{
    try {
      const parsed=parseBcvHtml(await fetchBcvHtml());const updatedAt=new Date().toISOString(); const source='BCV oficial - consulta directa';
      updateSettings({bcv_last_scraped_rate:parsed.rateText,bcv_last_updated:updatedAt,bcv_source_label:source,bcv_source_url:BCV_URL,bcv_value_date:parsed.valueDate,bcv_fetch_status:'live',bcv_last_error:''});
      return {success:true,...parsed,source,sourceUrl:BCV_URL,updatedAt};
    } catch(error) {
      const s=getAllSettings(); const official=s.bcv_source_url===BCV_URL;
      updateSettings({bcv_fetch_status:official?'cached':'unavailable',bcv_last_error:error.message});
      console.error('[BCV] Consulta oficial fallida:',error.message);
      return {success:false,rate:official?Number(s.bcv_last_scraped_rate):null,source:official?'BCV oficial - ultima consulta guardada':'BCV sin tasa oficial confirmada',sourceUrl:official?BCV_URL:null,valueDate:s.bcv_value_date||null,updatedAt:s.bcv_last_updated||null,error:error.message};
    }
  })();
  try{return await inFlight;}finally{inFlight=null;}
}
module.exports={scrapeBcvRate,parseBcvHtml,fetchBcvHtml};
