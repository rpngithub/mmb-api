const sequelize = require('../config/db');
const { Payment } = require('../models');

// Issues GST invoice numbers: MMB/<FY>/<6 digits>, sequential within an Indian
// financial year (April–March). A number is issued exactly once per successful
// payment and never changes afterwards — a tax invoice number that moves is
// worse than one with a gap in it.
//
// The sequence lives in `invoice_counters`, one row per FY, advanced by a single
// atomic UPSERT. `LAST_INSERT_ID(expr)` is the MySQL idiom for "return the value
// I just wrote" without a second read, and reading it back within the same
// transaction pins both statements to one connection. Two confirmations racing
// for the same payment (webhook and client callback both land) each draw a
// number; the conditional UPDATE lets only the first one stick and the other is
// simply burnt — a gap, which GST tolerates, rather than a renumbering, which it
// does not.

const PREFIX = 'MMB';

// "2026-27" for anything dated 1 Apr 2026 – 31 Mar 2027, on the IST calendar.
function financialYear(date = new Date()) {
  const ist   = new Date(date.getTime() + 330 * 60 * 1000);
  const year  = ist.getUTCFullYear();
  const month = ist.getUTCMonth(); // 0 = Jan
  const start = month >= 3 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

async function nextNumber(fy) {
  return sequelize.transaction(async (t) => {
    await sequelize.query(
      'INSERT INTO invoice_counters (fy, last_no) VALUES (:fy, LAST_INSERT_ID(1)) '
      + 'ON DUPLICATE KEY UPDATE last_no = LAST_INSERT_ID(last_no + 1)',
      { replacements: { fy }, transaction: t },
    );
    const [[row]] = await sequelize.query('SELECT LAST_INSERT_ID() AS n', { transaction: t });
    return Number(row.n);
  });
}

// Give this payment its number if it has none. Returns the number either way.
// Idempotent under retry and safe under concurrency (see above); `issuedAt`
// decides the FY and should be the payment's own paid_at when backfilling an
// older row, so it lands in the year it was actually paid.
async function assign(paymentId, issuedAt = new Date()) {
  const existing = await Payment.findByPk(paymentId, { attributes: ['id', 'invoice_number'] });
  if (!existing) return null;
  if (existing.invoice_number) return existing.invoice_number;

  const fy     = financialYear(issuedAt);
  const n      = await nextNumber(fy);
  const number = `${PREFIX}/${fy}/${String(n).padStart(6, '0')}`;

  const [updated] = await Payment.update(
    { invoice_number: number },
    { where: { id: paymentId, invoice_number: null } },
  );
  if (updated === 1) return number;

  // Lost the race: somebody else numbered it first. Theirs is the number.
  return (await Payment.findByPk(paymentId, { attributes: ['invoice_number'] })).invoice_number;
}

module.exports = { assign, financialYear };
