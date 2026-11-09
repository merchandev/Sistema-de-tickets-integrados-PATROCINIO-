const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Each run works on its own empty database.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "entradas-test-"));
const { parsePaymentForm, parseTicketNumber } = require("../sistema-central/src/paymentForm");
const store = require("../sistema-central/src/db");

const buyer = {
  buyer_first_name: " María ",
  buyer_last_name: "Pérez",
  buyer_cedula: "v-12.345.678",
  buyer_phone: "0414-1234567",
  buyer_email: "Maria@Correo.com",
  payment_bank: "Bancamiga (0172)",
  payment_reference: " 00123456 ",
};
const pricing = { screenshot_path: "", amount_usd: 5, bcv_rate: 100, amount_ves: 500 };
const report = (reference, extra = {}) =>
  store.submitPaymentReport({
    source_web: "pagina-web-1",
    session_id: "reporte",
    ...parsePaymentForm({ ...buyer, payment_reference: reference }).data,
    ...pricing,
    ...extra,
  });

test("payment form normalises buyer data and points to the first invalid field", () => {
  const parsed = parsePaymentForm(buyer);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.buyer_name, "María Pérez");
  assert.equal(parsed.data.buyer_cedula, "V-12345678");
  assert.equal(parsed.data.buyer_email, "maria@correo.com");
  assert.equal(parsed.data.payment_reference, "00123456");
  assert.equal(parsePaymentForm({ ...buyer, buyer_last_name: "" }).field, "buyer_last_name");
  assert.equal(parsePaymentForm({ ...buyer, buyer_cedula: "abc" }).field, "buyer_cedula");
  assert.equal(parsePaymentForm({ ...buyer, buyer_email: "maria@" }).field, "buyer_email");
  assert.equal(parsePaymentForm({ ...buyer, payment_bank: "" }).field, "payment_bank");
  assert.equal(parsePaymentForm({ ...buyer, payment_reference: "12" }).field, "payment_reference");
  assert.equal(parseTicketNumber("7"), "007");
  assert.equal(parseTicketNumber("251"), null);
});

test("the event Pago Móvil account is the one shown to buyers", () => {
  const account = store.getPublicConfig().payment_methods.pago_movil;
  assert.deepEqual(account, { banco: "Bancamiga (0172)", telefono: "0412-2905205", rif_cedula: "28298508" });
});

test("checkout orders keep the paying bank and the separate names", () => {
  const session = "sess_test_checkout";
  assert.equal(store.lockTicketAtomic("010", session, "pagina-web-2").success, true);
  const result = store.submitOrderAtomic({
    ticket_number: "010",
    session_id: session,
    ...parsePaymentForm(buyer).data,
    ...pricing,
  });
  assert.equal(result.success, true);
  assert.equal(result.order.payment_bank, "Bancamiga (0172)");
  assert.equal(result.order.buyer_last_name, "Pérez");
  assert.equal(result.order.report_kind, "CHECKOUT");
});

test("payment reports hold no ticket until approved with an available one", () => {
  const pending = report("99887766", { requested_ticket: "010", buyer_comment: "Pagué antes de que expirara" });
  assert.equal(pending.ticket_number, "");
  assert.equal(pending.report_kind, "REPORT");
  assert.match(store.approveOrderAtomic(pending.id, "", null).message, /número de entrada/);
  // 010 is already in verification for the checkout order above
  assert.match(store.approveOrderAtomic(pending.id, "", "010").message, /no está disponible/);
  const approved = store.approveOrderAtomic(pending.id, "ok", "011");
  assert.equal(approved.success, true);
  assert.equal(approved.order.ticket_number, "011");
  assert.match(approved.order.verification_token, /^TK-011-/);
  const ticket = store.db.prepare("SELECT status, current_order_id FROM tickets WHERE ticket_number = ?").get("011");
  assert.equal(ticket.status, "SOLD");
  assert.equal(ticket.current_order_id, pending.id);
  assert.equal(store.approveOrderAtomic(pending.id, "", "012").success, false);
});

test("rejecting a payment report only closes the report", () => {
  const pending = report("55554444");
  const before = store.db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE status = 'AVAILABLE'").get().c;
  const rejected = store.rejectOrderAtomic(pending.id, "La referencia no aparece");
  assert.equal(rejected.success, true);
  assert.equal(rejected.order.status, "REJECTED");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE status = 'AVAILABLE'").get().c, before);
  assert.equal(store.rejectOrderAtomic(pending.id, "otra vez").success, false);
});

test("emails carry a plain-text version with the payment details", async () => {
  const { sendPaymentSubmittedEmail, htmlToText } = require("../sistema-central/src/mailer");
  const sent = await sendPaymentSubmittedEmail(report("31415926"));
  assert.equal(sent.status, "SIMULATED_OUTBOX");
  const text = htmlToText(store.db.prepare("SELECT body_html FROM email_logs WHERE id = ?").get(sent.logId).body_html);
  assert.match(text, /Tu pago está en verificación/);
  assert.match(text, /hasta 24 horas/);
  assert.match(text, /Referencia: 31415926/);
  assert.doesNotMatch(text, /<[a-z]|&amp;/);
});

test("Mailpit captures test messages and a pending notice can be retried once through real SMTP", async (t) => {
  const nodemailer = require("../sistema-central/node_modules/nodemailer");
  const { sendPaymentSubmittedEmail, testMailConnections, retryOrderEmail } = require("../sistema-central/src/mailer");
  const previousHost = store.getAllSettings().smtp_host;
  t.after(() => store.updateSettings({ smtp_host: previousHost }));
  const sendMail = t.mock.fn(async () => ({ accepted: ["buyer@example.test"] }));
  const verify = t.mock.fn(async () => true);
  t.mock.method(nodemailer, "createTransport", () => ({ sendMail, verify }));

  store.updateSettings({ smtp_host: "mailpit" });
  const order = report("27182818");
  const captured = await sendPaymentSubmittedEmail(order);
  assert.equal(captured.status, "SIMULATED_OUTBOX");
  assert.equal((await testMailConnections()).smtp.ok, false);
  assert.equal(verify.mock.callCount(), 0);
  assert.equal((await retryOrderEmail(captured.logId)).ok, false);

  store.updateSettings({ smtp_host: "smtp.example.test" });
  const results = await Promise.all([retryOrderEmail(captured.logId), retryOrderEmail(captured.logId)]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal((await retryOrderEmail(captured.logId)).ok, false);
  assert.equal(sendMail.mock.callCount(), 2);
});
