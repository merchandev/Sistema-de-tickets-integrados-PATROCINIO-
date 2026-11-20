const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseBcvHtml} = require('../sistema-central/src/bcvParser');
const {calculateVes} = require('../sistema-central/src/money');
const html = value => `<div><div id="euro"><strong>999,00000000</strong></div><div id="dolar"><strong>${value}</strong></div><span class="date-display-single" content="2026-10-29T00:00:00-04:00"></span></div>`;
test('Extrae USD y fecha valor, conserva 8 decimales y admite separador de miles', () => {
  assert.deepEqual(parseBcvHtml(html('888,89090000')), {rate:888.8909,rateText:'888.89090000',valueDate:'2026-10-29'});
  assert.equal(parseBcvHtml(html('1.234,56789012')).rateText, '1234.56789012');
});
test('Rechaza HTML incompleto, tasa invalida o falta de fecha', () => {
  for (const value of ['','0,00000000','N/A','888.8909','888,12basura']) assert.throws(()=>parseBcvHtml(html(value)));
  assert.throws(()=>parseBcvHtml('<div id="dolar"><strong>888,89090000</strong></div>'));
});
test('Calcula bolivares con redondeo decimal del total y sin truncar tasa', () => {
  assert.equal(calculateVes(5,'888.89090000'),4444.45);
  assert.equal(calculateVes(5,'888.12345678'),4440.62);
  assert.equal(calculateVes(5,'1.00100000'),5.01);
  assert.equal(calculateVes('0.10','0.15000000'),0.02);
  assert.throws(()=>calculateVes(5,'NaN'));
});
test('La tasa oficial sigue vigente 24 horas o mientras su fecha valor no haya pasado', () => {
  const {officialRateCurrent, caracasDate} = require('../sistema-central/src/bcvRate');
  const now = new Date('2026-11-21T12:00:00-04:00');
  const old = '2026-11-19T00:00:00Z';
  assert.equal(officialRateCurrent({bcv_is_official:true, bcv_last_updated:old, bcv_value_date:'2026-11-23'}, now), true);
  assert.equal(officialRateCurrent({bcv_is_official:true, bcv_last_updated:old, bcv_value_date:'2026-11-21'}, now), true);
  assert.equal(officialRateCurrent({bcv_is_official:true, bcv_last_updated:old, bcv_value_date:'2026-11-20'}, now), false);
  assert.equal(officialRateCurrent({bcv_is_official:true, bcv_last_updated:old, bcv_value_date:''}, now), false);
  assert.equal(officialRateCurrent({bcv_is_official:true, bcv_last_updated:new Date(now - 3600e3).toISOString(), bcv_value_date:'2026-11-01'}, now), true);
  assert.equal(officialRateCurrent({bcv_is_official:false, bcv_last_updated:now.toISOString(), bcv_value_date:'2026-11-30'}, now), false);
  assert.equal(caracasDate(new Date('2026-11-21T03:30:00Z')), '2026-11-20');
});
