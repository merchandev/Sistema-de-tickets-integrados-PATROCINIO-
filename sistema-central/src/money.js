// Decimal arithmetic: round only the final VES amount to cents (half up).
function scaled(value,digits) {
  const text=String(value);
  if(!/^\d+(?:\.\d+)?$/.test(text))throw Error('Monto decimal invalido');
  const [whole,fraction='']=text.split('.');
  if(fraction.length>digits)throw Error('Demasiados decimales');
  return BigInt(whole)*10n**BigInt(digits)+BigInt(fraction.padEnd(digits,'0'));
}
function calculateVes(usd,rate) {
  const denominator=100000000n;
  const cents=(scaled(usd,2)*scaled(rate,8)+denominator/2n)/denominator;
  if(cents>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Monto fuera de rango');
  return Number(cents)/100;
}
module.exports={calculateVes};
