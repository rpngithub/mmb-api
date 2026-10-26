'use strict';

/**
 * A user's name is optional. OTP signup used to fill `users.name` with the phone
 * number purely to satisfy NOT NULL, so every account showed its own number as a
 * name until the user typed one. Now the column is nullable and signup leaves it
 * empty.
 *
 * Existing placeholders are cleared: only names that ARE the phone number — in
 * the canonical `+91XXXXXXXXXX` form, or the bare 10 digits / `91` + 10 digits
 * written before migration 038 normalized phones. A name someone actually typed
 * never matches, and purged tombstones ("Deleted User", phone NULL) are skipped.
 *
 * Must run BEFORE the code that creates users without a name ships, or every new
 * signup fails on the NOT NULL column.
 *
 * Mirrors src/models/user.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('users', 'name', {
      type: Sequelize.STRING(100),
      allowNull: true,
      defaultValue: null,
    });

    const [result] = await queryInterface.sequelize.query(`
      UPDATE users
         SET name = NULL
       WHERE phone IS NOT NULL
         AND (name = phone
              OR name = SUBSTRING(phone, 4)
              OR name = SUBSTRING(phone, 2))
    `);
    console.log(`[migration 052] cleared ${result.affectedRows ?? 0} phone-number placeholder name(s)`);
  },

  async down(queryInterface, Sequelize) {
    // Put the placeholder back so NOT NULL can be restored.
    await queryInterface.sequelize.query(
      "UPDATE users SET name = COALESCE(phone, 'User') WHERE name IS NULL",
    );
    await queryInterface.changeColumn('users', 'name', {
      type: Sequelize.STRING(100),
      allowNull: false,
    });
  },
};
