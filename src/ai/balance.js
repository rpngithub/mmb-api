const { Op } = require('sequelize');
const { sqlUtc } = require('../utils/sqlDate');

// Our prepaid balance at each provider, estimated from our own records — every
// provider is prepaid separately, and running dry means every call there fails
// (the adapter then trips the provider). Magnific has no balance endpoint on our
// plan as far as the docs say, so:
//
//   remaining ≈ Σ provider credits we bought  −  Σ provider units our jobs used since the first purchase
//
// "Used" counts every job that reached the provider: done jobs, and failed or
// unknown jobs that got a task id (we may have been billed for those — the docs
// do not say). provider_units_actual when the provider reported it, else the
// route's snapshotted provider_units. An estimate: reconcile against the
// provider's invoice monthly, and if their credits lapse (an annual allowance
// that resets monthly), record purchases accordingly.
//
// Alert threshold, per provider, in provider units: settings.low_balance_units,
// else 10% of what was bought in the last 12 months. An alert emails
// AI_ALERT_EMAILS (comma-separated) and is logged; it repeats at most once a day
// per provider (settings.last_balance_alert_at).

const DEFAULT_ALERT_FRACTION = 0.10;
const ALERT_EVERY_MS = 24 * 3600 * 1000;

const alertEmails = () => (process.env.AI_ALERT_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);

async function balances(now = new Date()) {
  const { AiProvider, ProviderCreditPurchase, sequelize } = require('../models');
  const providers = await AiProvider.findAll();
  const yearAgo = new Date(now); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  const out = [];

  for (const p of providers) {
    // Billed in arrears: there is no prepaid balance to run out of. Any "purchases"
    // recorded for it are invoices, which only feed the cost per unit.
    if (p.settings?.billing === 'postpaid') continue;
    const purchases = await ProviderCreditPurchase.findAll({ where: { provider_id: p.id }, order: [['purchased_at', 'ASC']] });
    if (!purchases.length) continue;   // nothing bought, nothing to track (e.g. the fake provider)

    const bought = purchases.reduce((s, r) => s + Number(r.credits_received), 0);
    const boughtYear = purchases.filter((r) => new Date(r.purchased_at) >= yearAgo).reduce((s, r) => s + Number(r.credits_received), 0);
    const since = purchases[0].purchased_at;

    const [[row]] = await sequelize.query(
      `SELECT COALESCE(SUM(COALESCE(provider_units_actual, provider_units)), 0) AS used
         FROM ai_jobs
        WHERE provider_id = ? AND sent_at >= ?
          AND (status = 'done' OR (status IN ('failed', 'unknown', 'processing') AND provider_task_id IS NOT NULL))`,
      { replacements: [p.id, sqlUtc(since)] },   // UTC, like sent_at — utils/sqlDate.js
    );
    const used = Number(row.used);
    const configured = Number(p.settings?.low_balance_units);
    const threshold = Number.isFinite(configured) && configured > 0
      ? configured
      : Math.round((boughtYear || bought) * DEFAULT_ALERT_FRACTION);
    const remaining = bought - used;
    out.push({
      provider_id: p.id, provider_key: p.key, bought_units: bought, used_units: used,
      remaining_units: remaining, alert_below_units: threshold, low: remaining < threshold,
      last_alert_at: p.settings?.last_balance_alert_at || null,
    });
  }
  return out;
}

async function checkAndAlert(now = new Date()) {
  const { AiProvider } = require('../models');
  const mailer = require('../utils/mailer');
  const alerted = [];

  for (const b of await balances(now)) {
    if (!b.low) continue;
    if (b.last_alert_at && now.getTime() - new Date(b.last_alert_at).getTime() < ALERT_EVERY_MS) continue;

    const text =
      `Our estimated prepaid balance at ${b.provider_key} is ${Math.round(b.remaining_units)} units ` +
      `(alert threshold ${b.alert_below_units}; bought ${b.bought_units}, used ${Math.round(b.used_units)}).\n\n` +
      'Top it up before it runs out: when it does, every AI request there fails and the provider is taken out of rotation. ' +
      'Then record the purchase in the admin panel (AI → Credit purchases) so this estimate and the cost per unit stay right.';
    console.error(`[AI] LOW PROVIDER BALANCE: ${b.provider_key} ≈ ${Math.round(b.remaining_units)} units left (threshold ${b.alert_below_units})`);
    for (const to of alertEmails()) {
      await mailer.sendMailQuietly({ to, subject: `[MakeMyBrand] Low ${b.provider_key} AI balance`, text });
    }

    const p = await AiProvider.findByPk(b.provider_id);
    await p.update({ settings: { ...(p.settings || {}), last_balance_alert_at: now.toISOString() } });
    alerted.push(b.provider_key);
  }
  return alerted;
}

module.exports = { balances, checkAndAlert, alertEmails, DEFAULT_ALERT_FRACTION };
