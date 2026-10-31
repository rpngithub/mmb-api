'use strict';

/**
 * Brand Series access, "option B" (decided 2026-10-28).
 *
 * Before: a subscription unlocked every variant its plan was listed on, and the
 * Brand Series quota only limited "Add to your Business", counted per SERIES and
 * reset monthly. So Basic's "2 Brand Series" limited nothing anyone could use.
 *
 * After: a subscription unlocks nothing by itself. A subscriber USES a variant only
 * once their business has added it, and the quota caps how many variants are added
 * at a time (Basic 2, Pro 5, Elite 10). Past that, they buy one (000055).
 *
 * This migration does the data half:
 *
 * 1. feature_types `brand_series` becomes a GAUGE (reset_period 'never'). As a
 *    monthly flow the quota would be a tally of adds and hand out a fresh N every
 *    month; as a gauge it is "N at a time", counted live from business_variants.
 *
 * 2. Existing adds are trimmed to each subscriber's quota, keeping the most recently
 *    added — the same rule a downgrade applies from now on (variantQuota.trimToQuota).
 *    Users WITHOUT an active subscription are left alone: their adds are paused, not
 *    removed, and are trimmed if and when they subscribe again.
 *
 * Not reversible in full: trimmed rows are gone. `down` restores the reset period only.
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql, replacements = {}) => queryInterface.sequelize.query(sql, { replacements });

    await q("UPDATE feature_types SET reset_period = 'never' WHERE `key` = 'brand_series'");

    // Each subscriber who has added anything, with their plan's brand_series limit.
    // No plan_features row, or -1, means unlimited: nothing to trim.
    const [subscribers] = await q(
      `SELECT s.user_id, pf.value AS lim
         FROM user_subscriptions s
         JOIN plan_features pf ON pf.plan_id = s.plan_id
         JOIN feature_types ft ON ft.id = pf.feature_type_id AND ft.\`key\` = 'brand_series'
        WHERE s.status = 'active'
          AND pf.value >= 0
          AND EXISTS (SELECT 1 FROM business_variants bv JOIN businesses b ON b.id = bv.business_id
                       WHERE b.user_id = s.user_id)`,
    );

    let removed = 0;
    for (const { user_id: userId, lim } of subscribers) {
      const [rows] = await q(
        `SELECT bv.id, bv.variant_id
           FROM business_variants bv
           JOIN businesses b ON b.id = bv.business_id
          WHERE b.user_id = :userId
          ORDER BY bv.created_at DESC, bv.id DESC`,
        { userId },
      );

      // Keep the newest `lim` distinct variants; a variant added to two businesses
      // is one slot, so all of its rows are kept together.
      const keep = new Set();
      for (const r of rows) {
        if (keep.size >= Number(lim)) break;
        keep.add(r.variant_id);
      }
      const drop = rows.filter((r) => !keep.has(r.variant_id)).map((r) => r.id);
      if (drop.length) {
        await q('DELETE FROM business_variants WHERE id IN (:drop)', { drop });
        removed += drop.length;
        console.log(`[056] user ${userId}: kept ${keep.size}, removed ${drop.length} added variant(s) over a limit of ${lim}`);
      }
    }
    console.log(`[056] brand_series is now a gauge; ${removed} over-quota added variant row(s) removed`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      "UPDATE feature_types SET reset_period = 'monthly' WHERE `key` = 'brand_series'",
    );
  },
};
