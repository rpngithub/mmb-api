'use strict';

/**
 * Special-event `type` re-cut to the calendar the content team actually
 * curates: Festivals, Public Days, Celebration Days, Awareness Days (+ custom).
 *
 *   holiday     -> kept, labelled "Public Days" in admin
 *   festival    -> NEW  (Diwali, Holi, Eid, ...)
 *   celebration -> NEW  (Mother's Day, Friendship Day, ...)
 *   awareness   -> kept
 *   custom      -> kept
 *   observance  -> DROPPED; existing rows become `celebration`, the nearest of
 *                  the new buckets (an "observance" here was always a
 *                  celebrate-with-a-post day, never a public holiday).
 *
 * Three steps because MySQL cannot drop an ENUM member that rows still use:
 * widen to old+new, remap, then narrow. The seeded `special_day_reminder`
 * notification (034) filters on `event_types: ['observance']`; it follows the
 * remap so the reminder keeps firing for the same events.
 */
const OLD    = ['holiday', 'observance', 'awareness', 'custom'];
const NEW    = ['holiday', 'festival', 'celebration', 'awareness', 'custom'];
const BRIDGE = ['holiday', 'observance', 'festival', 'celebration', 'awareness', 'custom'];

const column = (Sequelize, values) => ({ type: Sequelize.ENUM(...values), allowNull: false });

module.exports = {
  async up(queryInterface, Sequelize) {
    const sql = queryInterface.sequelize;
    await queryInterface.changeColumn('special_events', 'type', column(Sequelize, BRIDGE));
    await sql.query("UPDATE special_events SET type = 'celebration' WHERE type = 'observance'");
    await queryInterface.changeColumn('special_events', 'type', column(Sequelize, NEW));

    await sql.query(
      `UPDATE notification_templates
          SET trigger_config = REPLACE(trigger_config, '"observance"', '"celebration"')
        WHERE trigger_config LIKE '%"observance"%'`,
    );
  },

  async down(queryInterface, Sequelize) {
    const sql = queryInterface.sequelize;
    await queryInterface.changeColumn('special_events', 'type', column(Sequelize, BRIDGE));
    await sql.query("UPDATE special_events SET type = 'observance' WHERE type IN ('festival', 'celebration')");
    await queryInterface.changeColumn('special_events', 'type', column(Sequelize, OLD));

    await sql.query(
      `UPDATE notification_templates
          SET trigger_config = REPLACE(trigger_config, '"celebration"', '"observance"')
        WHERE trigger_config LIKE '%"celebration"%'`,
    );
  },
};
