const https = require('node:https');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const {X509Certificate} = require('node:crypto');
const {parseBcvHtml} = require('./bcvParser');
const {updateSettings, getAllSettings} = require('./db');
const BCV_URL = 'https://www.bcv.org.ve/';
const CERTS_DIR = path.join(__dirname, 'certs');

// BCV's server does not send the intermediate certificate of its chain. Node gets the intermediates
// saved in certs/ and, when BCV changes issuer, the one named in its certificate's AIA field.
// They only help build the chain: it must still end in a public root (no partial chains, TLS stays strict).
const bundled = fs.readdirSync(CERTS_DIR).filter(f => f.endsWith('.pem')).map(f => fs.readFileSync(path.join(CERTS_DIR, f), 'utf8'));
const learned = new Map();
let agent = buildAgent();
function buildAgent() {
  return new https.Agent({ca:[...tls.rootCertificates, ...bundled, ...learned.values()], rejectUnauthorized:true});
}

const MISSING_ISSUER = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT']);

// Reads BCV's certificate (nothing is sent over this connection) to learn where its issuer is published.
function peerCertificate(host) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({host, port:443, servername:host, rejectUnauthorized:false}, () => {
      const raw = socket.getPeerCertificate()?.raw;
      socket.end();
      raw ? resolve(new X509Certificate(raw)) : reject(Error('BCV no presento certificado'));
    });
    socket.setTimeout(10000, () => socket.destroy(Error('Timeout leyendo el certificado de BCV')));
    socket.on('error', reject);
  });
}

async function learnMissingIntermediate(host) {
  const leaf = await peerCertificate(host);
  const urls = [...String(leaf.infoAccess || '').matchAll(/CA Issuers - URI:(\S+)/g)].map(m => m[1]).filter(u => /^https?:\/\//.test(u));
  for (const url of urls) {
    if (learned.has(url)) continue;
    const res = await fetch(url, {signal:AbortSignal.timeout(10000), redirect:'follow'});
    const body = Buffer.from(await res.arrayBuffer());
    if (!res.ok || body.length > 64 * 1024) continue;
    const issuer = new X509Certificate(body.includes('-----BEGIN') ? body.toString('utf8') : body);
    if (!issuer.ca || !leaf.checkIssued(issuer) || !leaf.verify(issuer.publicKey)) continue;
    learned.set(url, issuer.toString());
    agent = buildAgent();
    console.warn('[BCV] Intermedio incorporado desde AIA:', issuer.subject.replace(/\n/g, ', '), '- SHA-256', issuer.fingerprint256);
    return true;
  }
  return false;
}

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

async function fetchBcvHtmlWithChainRepair(url = BCV_URL) {
  try {
    return await fetchBcvHtml(url);
  } catch (error) {
    if (!MISSING_ISSUER.has(error.code)) throw error;
    let repaired = false;
    try { repaired = await learnMissingIntermediate(new URL(url).hostname); } catch (aiaError) {
      console.error('[BCV] No se pudo obtener el intermedio desde AIA:', aiaError.message);
    }
    if (!repaired) throw error;
    return fetchBcvHtml(url);
  }
}

let inFlight = null;
async function scrapeBcvRate({maxAgeMs=0}={}) {
  const settings=getAllSettings();
  if(maxAgeMs>0&&settings.bcv_source_url===BCV_URL&&settings.bcv_fetch_status==='live'&&Date.now()-Date.parse(settings.bcv_last_updated)<maxAgeMs) return {success:true,cached:true,rate:Number(settings.bcv_last_scraped_rate),source:settings.bcv_source_label,sourceUrl:BCV_URL,valueDate:settings.bcv_value_date,updatedAt:settings.bcv_last_updated};
  if(inFlight)return inFlight;
  inFlight=(async()=>{
    try {
      const parsed=parseBcvHtml(await fetchBcvHtmlWithChainRepair());const updatedAt=new Date().toISOString(); const source='BCV oficial - consulta directa';
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

module.exports={scrapeBcvRate,parseBcvHtml,fetchBcvHtml,learnMissingIntermediate};
