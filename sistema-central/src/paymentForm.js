// Validation of the buyer and payment data sent by the checkout popup and the payment report form.
// Each error names the field so the page can point the buyer to it.

const clean = (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '');
const NAME = /^[\p{L}][\p{L}' .-]{1,59}$/u;

function parsePaymentForm(body = {}) {
  const first = clean(body.buyer_first_name);
  const last = clean(body.buyer_last_name);
  const cedula = clean(body.buyer_cedula).toUpperCase().replace(/[.\s]/g, '');
  const phone = clean(body.buyer_phone);
  const email = clean(body.buyer_email).toLowerCase();
  const reference = clean(body.payment_reference).replace(/\s/g, '');
  const bank = clean(body.payment_bank);
  const phoneDigits = phone.replace(/\D/g, '');

  const fail = (field, message) => ({ ok: false, field, message });
  if (!NAME.test(first)) return fail('buyer_first_name', 'Escribe tu nombre.');
  if (!NAME.test(last)) return fail('buyer_last_name', 'Escribe tu apellido.');
  if (!/^[VEJPG]?-?\d{5,10}$/.test(cedula)) return fail('buyer_cedula', 'Revisa el número de cédula (ejemplo: V-12345678).');
  if (!/^\+?[\d\s()-]+$/.test(phone) || phoneDigits.length < 10 || phoneDigits.length > 13) return fail('buyer_phone', 'Revisa el teléfono (ejemplo: 0414-1234567).');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('buyer_email', 'Revisa el correo electrónico.');
  if (bank.length < 2 || bank.length > 80) return fail('payment_bank', 'Indica el banco desde el que pagaste.');
  if (!/^[A-Za-z0-9-]{4,30}$/.test(reference)) return fail('payment_reference', 'Revisa el número de referencia del pago (solo números y letras).');

  return {
    ok: true,
    data: {
      buyer_first_name: first,
      buyer_last_name: last,
      buyer_name: `${first} ${last}`,
      buyer_cedula: cedula,
      buyer_phone: phone,
      buyer_email: email,
      payment_phone: phone,
      payment_reference: reference,
      payment_bank: bank
    }
  };
}

// "7", "07" or "007" -> "007"; anything outside 001-250 -> null.
function parseTicketNumber(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const number = Number(text);
  return number >= 1 && number <= 250 ? String(number).padStart(3, '0') : null;
}

module.exports = { parsePaymentForm, parseTicketNumber };
