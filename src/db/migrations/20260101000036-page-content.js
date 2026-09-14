'use strict';

/**
 * Page content — the editorial blocks that sit under the template grid on a
 * website page ("Why Choose Make My Brand?", "Content Ideas", "Business Growth").
 *
 * These were hardcoded per industry in the website repo, which is how a Travel
 * page ended up advertising "professionally designed fitness content" and a
 * heading reading "Create Content for Every Travel Marketing Need" over a chip
 * list of gym services. Copy-paste plus a partial find-and-replace, roughly a
 * hundred times over. This table is the fix.
 *
 * WHAT THIS OWNS AND WHAT IT DOESN'T. The API owns the words, the images and the
 * order. It does NOT own layout: there is no column for a colour, a grid width or
 * a variant. The website maps `section_key` to one of its own components and
 * styles it however it likes, so a redesign never becomes a migration here.
 *
 * TWO LEVELS, ONE MERGE RULE. A row with `business_category_id = NULL` is the
 * DEFAULT for its page — authored once, served to every industry. A row with an
 * industry set OVERRIDES the default of the same `section_key` for that industry
 * alone. Resolution is per section_key, not all-or-nothing, so an industry can
 * carry a bespoke "Content Ideas" (the chips genuinely differ per trade) while
 * still inheriting a "Why Choose" block that nobody has to retype. An override
 * with is_active = 0 HIDES the default for that industry — that is the only way
 * to suppress an inherited block, and it is why the resolver reads overrides
 * regardless of their active flag (see services/pageContent.service.js).
 *
 * TOKENS, NOT COPIES. Body text may contain `{{industry}}` / `{{industry_lower}}`,
 * substituted at read time from the industry being served. That is what makes one
 * default row correct on all hundred pages, and what makes the drift above
 * impossible to reintroduce by hand.
 *
 * NOTE on the unique index: MySQL permits unlimited NULLs in a UNIQUE index, so
 * `uq_page_sections_scope` does NOT constrain the default rows (the ones whose
 * business_category_id is NULL) — exactly the rows a second duplicate would hurt
 * most. The real guard is the composite check in the admin layer's `beforeWrite`;
 * the index is here for the industry-scoped rows and for the lookup itself.
 *
 * Mirrors src/models/pageSection.model.js and pageSectionItem.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S   = Sequelize;
    const now = S.literal('CURRENT_TIMESTAMP');

    const bothTs = {
      created_at: { type: S.DATE, allowNull: false, defaultValue: now },
      updated_at: { type: S.DATE, allowNull: false, defaultValue: now },
    };

    // ---- page_sections ----
    await queryInterface.createTable('page_sections', {
      id:  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid: { type: S.UUID, allowNull: false, unique: true },

      // Which website page this block belongs to. 'industry' is the only value in
      // use today; it is a string rather than an ENUM so the marketing team can be
      // given a 'home' or 'pricing' page without a schema change.
      page_key: { type: S.STRING(50), allowNull: false, defaultValue: 'industry' },

      // NULL = the default served to every industry. Set = an override for that
      // industry only. CASCADE because an override is meaningless once the
      // industry it was written for is gone.
      business_category_id: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'business_categories', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },

      // The stable contract with the website: it renders on this, not on position.
      // Renaming one silently blanks a block on the live site, so treat these as
      // permanent once published.
      section_key: { type: S.STRING(50), allowNull: false },

      // The small pill above the heading ("Why Choose Make My Brand?").
      eyebrow:     { type: S.STRING(150), allowNull: true },
      heading:     { type: S.STRING(255), allowNull: true },
      subheading:  { type: S.TEXT, allowNull: true },

      // The section-level illustration (the phone mockup in the Content Ideas and
      // Business Growth blocks). Per-item artwork lives on the item instead.
      image_s3_key: { type: S.STRING(500), allowNull: true },

      display_order: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      is_active:     { type: S.TINYINT, allowNull: false, defaultValue: 1 },
      ...bothTs,
    });

    // One section per key per scope. See the NULL caveat in the header comment.
    await queryInterface.addIndex('page_sections', ['page_key', 'business_category_id', 'section_key'], {
      unique: true, name: 'uq_page_sections_scope',
    });
    // Backs the FK and the "everything overridden for this industry" read.
    await queryInterface.addIndex('page_sections', ['business_category_id'], { name: 'idx_page_sections_industry' });

    // ---- page_section_items ----
    // The repeated children: the six feature cards, the chip list, the four
    // numbered growth steps. One shape covers all three — a chip fills only
    // `title`, a card fills `title` + `body` + `icon_s3_key`.
    await queryInterface.createTable('page_section_items', {
      id:  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid: { type: S.UUID, allowNull: false, unique: true },
      section_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'page_sections', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      title:        { type: S.STRING(200), allowNull: true },
      body:         { type: S.TEXT, allowNull: true },
      icon_s3_key:  { type: S.STRING(500), allowNull: true },
      // Optional destination for chips that should link somewhere (a filtered
      // template listing, say). The website decides whether to render it as a link.
      link_url:     { type: S.STRING(500), allowNull: true },
      display_order: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      is_active:     { type: S.TINYINT, allowNull: false, defaultValue: 1 },
      ...bothTs,
    });

    // The only read this table ever serves: one section's items, in editor order.
    await queryInterface.addIndex('page_section_items', ['section_id', 'display_order'], {
      name: 'idx_page_section_items_section',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('page_section_items');
    await queryInterface.dropTable('page_sections');
  },
};
