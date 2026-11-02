const cheerio = require('cheerio');
function parseBcvHtml(html) {
  const $=cheerio.load(html);
  const rawRate=$('#dolar strong').first().text().trim().replace(/\s/g,'');
  if (!/^(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2,8}$/.test(rawRate)) throw Error('Tasa USD ausente o formato BCV inesperado');
  const rateText=rawRate.replace(/\./g,'').replace(',','.'); const rate=Number(rateText);
  if (!Number.isFinite(rate)||rate<=0) throw Error('Tasa USD BCV invalida');
  const valueDate=$('#dolar').parent().find('.date-display-single[content]').first().attr('content') || $('.date-display-single[content]').first().attr('content');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(valueDate||'')) throw Error('Fecha valor BCV ausente');
  return {rate,rateText,valueDate:valueDate.slice(0,10)};
}
module.exports = {parseBcvHtml};
