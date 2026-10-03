'use strict';

/**
 * Favourites — a user's saved designs and assets.
 *
 * Two tables rather than one polymorphic (entity_type, entity_id) table, so each
 * row has a real foreign key: deleting a design or an asset takes its favourites
 * with it, and a favourite can never point at something that does not exist.
 *
 * A template favourite names the DESIGN (template family), not one language ×
 * size version — the heart is on the card, and the card is the design. The list
 * shows each saved design in the viewer's best version, exactly as the feed does.
 *
 * `template_families.likes_count` becomes the live number of favourites. It is
 * kept in step by the service (±1 only when a row was actually inserted or
 * deleted) rather than counted on read, because every card in every feed shows it.
 * Nothing wrote to it before this, so it starts at 0 everywhere and is correct
 * as-is — no backfill.
 *
 * No `uid` and no `updated_at`: a favourite is addressed by (user, target) and is
 * never edited, only added or removed.
 *
 * Mirrors src/models/userFavouriteTemplate.model.js, userFavouriteAsset.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S   = Sequelize;
    const now = S.literal('CURRENT_TIMESTAMP');

    const userId = {
      type: S.INTEGER, allowNull: false,
      references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
    };
    const created = { type: S.DATE, allowNull: false, defaultValue: now };

    await queryInterface.createTable('user_favourite_templates', {
      id:      { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: userId,
      family_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'template_families', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      created_at: created,
    });
    // One heart per (user, design) — what makes add/remove idempotent.
    await queryInterface.addIndex('user_favourite_templates', ['user_id', 'family_id'], { unique: true, name: 'uq_user_fav_template' });
    // "My favourites", newest first.
    await queryInterface.addIndex('user_favourite_templates', ['user_id', 'created_at'], { name: 'ix_user_fav_template_recent' });

    await queryInterface.createTable('user_favourite_assets', {
      id:      { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: userId,
      asset_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'assets', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      created_at: created,
    });
    await queryInterface.addIndex('user_favourite_assets', ['user_id', 'asset_id'], { unique: true, name: 'uq_user_fav_asset' });
    await queryInterface.addIndex('user_favourite_assets', ['user_id', 'created_at'], { name: 'ix_user_fav_asset_recent' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('user_favourite_assets');
    await queryInterface.dropTable('user_favourite_templates');
    // likes_count was only ever written by favourites; leave nothing behind.
    await queryInterface.sequelize.query('UPDATE template_families SET likes_count = 0');
  },
};
