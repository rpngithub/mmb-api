// Renders the invoice and the receipt as self-contained, print-ready HTML.
//
// HTML rather than PDF on purpose: the API cannot take on a PDF dependency in
// this environment (see CLAUDE.md on npm), and a browser's print-to-PDF of a page
// laid out for A4 is indistinguishable from a generated one. The FE opens the
// document in a new tab / webview and offers Print or Save. No script in the
// page — helmet's CSP would block it anyway — so the print trigger is the FE's.
//
// Pure: takes the assembled data (services/billing.service builds it), returns a
// string. Every user- and admin-authored value goes through esc(); nothing here
// touches the database or the request.

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
}) : '—');

const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
}) : '—');

const METHOD_LABEL = {
  upi: 'UPI', card: 'Card', netbanking: 'Net Banking', wallet: 'Wallet', emi: 'EMI', other: 'Online',
};

const STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; background: #fff; }
  .doc { max-width: 760px; margin: 0 auto; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 16px; margin-bottom: 24px; }
  .brand { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
  .title { text-align: right; }
  .title h1 { margin: 0; font-size: 20px; text-transform: uppercase; letter-spacing: 0.08em; }
  .title .no { color: #555; margin-top: 4px; }
  .parties { display: flex; gap: 32px; margin-bottom: 24px; }
  .party { flex: 1; }
  .party h3 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #777; }
  .party p { margin: 0; white-space: pre-line; }
  .muted { color: #777; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th, td { padding: 10px 8px; text-align: left; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #777; font-weight: 600; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .totals { width: 320px; margin-left: auto; }
  .totals td { border: 0; padding: 6px 8px; }
  .totals tr.grand td { border-top: 2px solid #111; font-weight: 700; font-size: 16px; padding-top: 10px; }
  .meta { margin-top: 24px; }
  .meta td:first-child { color: #777; width: 200px; }
  .paid { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #e6f7ee; color: #0a7a3d; font-weight: 600; font-size: 12px; letter-spacing: 0.04em; }
  .foot { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e5e5; color: #777; font-size: 12px; }
  @media print { body { padding: 0; } }
`;

function partyBlock(heading, p) {
  const lines = [p.name, p.address, [p.state, p.pincode].filter(Boolean).join(' – '), p.email, p.phone]
    .filter(Boolean).map(esc).join('\n');
  const gstin = p.gstin
    ? `<p class="muted">GSTIN: ${esc(p.gstin)}</p>`
    : (p.gstin_pending ? '<p class="muted">GSTIN: registration pending</p>' : '');
  return `<div class="party"><h3>${esc(heading)}</h3><p>${lines}</p>${gstin}</div>`;
}

function shell(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><div class="doc">${body}</div></body></html>`;
}

// data: { seller, buyer, payment, line, tax, number, issued_at }
function invoice(data) {
  const { seller, buyer, payment, line, tax } = data;
  const taxRows = tax.split === 'intra'
    ? `<tr><td>CGST @ ${tax.half_rate}%</td><td class="num">${money(tax.half_amount)}</td></tr>
       <tr><td>SGST @ ${tax.half_rate}%</td><td class="num">${money(tax.half_amount)}</td></tr>`
    : `<tr><td>IGST @ ${tax.rate}%</td><td class="num">${money(tax.amount)}</td></tr>`;

  const body = `
<div class="head">
  <div class="brand">${esc(seller.name)}</div>
  <div class="title"><h1>Tax Invoice</h1><div class="no">${esc(data.number)}</div><div class="no">Date: ${fmtDate(data.issued_at)}</div></div>
</div>
<div class="parties">
  ${partyBlock('From', seller)}
  ${partyBlock('Bill to', buyer)}
</div>
<table>
  <thead><tr><th>Description</th><th>SAC</th><th class="num">Taxable value</th></tr></thead>
  <tbody>
    <tr>
      <td>${esc(line.description)}${line.period ? `<div class="muted">${esc(line.period)}</div>` : ''}${line.coupon ? `<div class="muted">Coupon applied: ${esc(line.coupon)}</div>` : ''}</td>
      <td>${esc(seller.sac_code)}</td>
      <td class="num">${money(payment.amount_before_tax)}</td>
    </tr>
  </tbody>
</table>
<table class="totals">
  <tr><td>Taxable value</td><td class="num">${money(payment.amount_before_tax)}</td></tr>
  ${taxRows}
  <tr class="grand"><td>Total</td><td class="num">${money(payment.amount)}</td></tr>
</table>
<table class="meta">
  <tr><td>Place of supply</td><td>${esc(tax.place_of_supply || '—')}</td></tr>
  <tr><td>Payment status</td><td><span class="paid">PAID</span> &nbsp; ${fmtDateTime(payment.paid_at)}</td></tr>
  <tr><td>Payment reference</td><td>${esc(payment.razorpay_payment_id || '—')}</td></tr>
  <tr><td>Payment method</td><td>${esc(payment.method_label || 'Online')}</td></tr>
</table>
<div class="foot">
  This is a computer-generated invoice and does not require a signature.
  ${seller.email ? `Queries: ${esc(seller.email)}` : ''}
</div>`;
  return shell(`Invoice ${data.number}`, body);
}

function receipt(data) {
  const { seller, buyer, payment, line } = data;
  const body = `
<div class="head">
  <div class="brand">${esc(seller.name)}</div>
  <div class="title"><h1>Payment Receipt</h1><div class="no">Receipt for ${esc(data.number)}</div><div class="no">Date: ${fmtDate(payment.paid_at)}</div></div>
</div>
<div class="parties">
  ${partyBlock('Received from', buyer)}
  ${partyBlock('Received by', seller)}
</div>
<table class="meta">
  <tr><td>Amount received</td><td><strong>${money(payment.amount)}</strong> <span class="paid">PAID</span></td></tr>
  <tr><td>Towards</td><td>${esc(line.description)}${line.period ? ` <span class="muted">(${esc(line.period)})</span>` : ''}</td></tr>
  <tr><td>Paid on</td><td>${fmtDateTime(payment.paid_at)}</td></tr>
  <tr><td>Payment method</td><td>${esc(payment.method_label || 'Online')}</td></tr>
  <tr><td>Payment reference</td><td>${esc(payment.razorpay_payment_id || '—')}</td></tr>
  <tr><td>Invoice</td><td>${esc(data.number)}</td></tr>
</table>
<div class="foot">Thank you for your payment. This receipt acknowledges the amount received; the tax invoice carries the GST breakup.</div>`;
  return shell(`Receipt ${data.number}`, body);
}

const methodLabel = (payment) => {
  if (!payment.payment_method) return null;
  const base = METHOD_LABEL[payment.payment_method] || 'Online';
  return payment.payment_method_detail ? `${base} (${payment.payment_method_detail})` : base;
};

module.exports = { invoice, receipt, methodLabel };
