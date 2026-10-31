'use strict';

/**
 * Frame families: one frame, many versions — the template-families split (045)
 * applied to frames.
 *
 * A frame sits over a poster, so it must match the poster's size, and its text
 * (taglines, labels) is in some language. One `frames` row held one design, so the
 * only way to offer a frame in 1:1 and 4:5, or in Tamil and English, was a second
 * frame: a second card, a second purchase, a second name. Now:
 *
 *   frames          the FAMILY. Keeps its id and uid and everything shared: name
 *                   (now unique in the database, not only in adminCrud), category,
 *                   frame_type, is_premium, price, strike_price, display_order,
 *                   status. Ownership (user_frames), payments, businesses.active_frame_id
 *                   and billing labels all keep pointing at it unchanged — buying a
 *                   frame buys every version of it.
 *   frame_versions  one language (NULL = text-free) × one size (template_sizes —
 *                   the same sizes posters use) with its own design and thumbnail.
 *                   Unique per (frame, language, size).
 *
 * Existing data: every frame with a design becomes a family of ONE text-free
 * version in the default size (app_settings.default_template_size, else 1080×1350).
 * Text-free because nothing recorded a language and text-free is shown to everyone,
 * so the store looks exactly as it did. Each copy is logged: an admin should check
 * the size and set the language where the frame has text.
 *
 * Duplicate frame names stop the migration BEFORE anything changes (the unique
 * index would fail half-way otherwise). Rename them in the admin panel and re-run.
 *
 * MariaDB cannot run DDL in a transaction, so every step checks whether it already
 * ran; a half-applied run can simply be run again.
 */

const DEFAULT_SIZE = { width: 1080, height: 1350 };
const DEFAULT_SIZE_KEY = 'default_template_size';

// Columns that move from frames to frame_versions.
const MOVED = ['content', 'thumbnail_s3_key'];

const query = (qi, sql, replacements) => qi.sequelize.query(sql, { replacements }).then(([rows]) => rows);

const scalar = async (qi, sql, replacements) => Number((await query(qi, sql, replacements))[0].n) > 0;

const tableExists = (qi, table) => scalar(qi,
  `SELECT COUNT(*) AS n FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = ?`, [table]);

const columnExists = (qi, table, column) => scalar(qi,
  `SELECT COUNT(*) AS n FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);

const indexExists = (qi, table, name) => scalar(qi,
  `SELECT COUNT(*) AS n FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`, [table, name]);

// The size existing frames are filed under: the admin-chosen default, else 1080×1350.
async function defaultSizeId(qi) {
  const [setting] = await query(qi, 'SELECT `value` FROM app_settings WHERE `key` = ?', [DEFAULT_SIZE_KEY]);
  if (setting && setting.value) {
    const [bySlug] = await query(qi, 'SELECT id FROM template_sizes WHERE slug = ?', [setting.value]);
    if (bySlug) return bySlug.id;
  }
  const [byDims] = await query(qi,
    'SELECT id FROM template_sizes WHERE width = ? AND height = ? ORDER BY id ASC LIMIT 1',
    [DEFAULT_SIZE.width, DEFAULT_SIZE.height]);
  return byDims ? byDims.id : null;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi  = queryInterface;
    const S   = Sequelize;
    const now = S.literal('CURRENT_TIMESTAMP');

    // 0. Refuse up front on duplicate names — before any DDL, so nothing is half-done.
    if (!(await indexExists(qi, 'frames', 'uq_frame_name'))) {
      const dupes = await query(qi,
        'SELECT name, GROUP_CONCAT(uid) AS uids FROM frames GROUP BY name HAVING COUNT(*) > 1');
      if (dupes.length) {
        for (const d of dupes) console.log(`[migration 058] duplicate frame name "${d.name}": ${d.uids}`);
        throw new Error(`[migration 058] ${dupes.length} frame name(s) are used more than once — rename them, then re-run`);
      }
    }

    // 1. The version table.
    if (!(await tableExists(qi, 'frame_versions'))) {
      await qi.createTable('frame_versions', {
        id:       { type: S.INTEGER, primaryKey: true, autoIncrement: true },
        uid:      { type: S.UUID, allowNull: false, unique: true },
        frame_id: {
          type: S.INTEGER, allowNull: false,
          references: { model: 'frames', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
        // RESTRICT, as on templates (045): a generated column may not be computed from
        // a column whose FK cascades or sets null (MariaDB 11.8 refuses with #1901),
        // and deleting a language still in use should be a 409 anyway.
        language_id: {
          type: S.INTEGER, allowNull: true,
          references: { model: 'languages', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT',
        },
        // NULL only while a draft is being set up; the version gate needs one to publish.
        size_id: {
          type: S.INTEGER, allowNull: true,
          references: { model: 'template_sizes', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
        },
        thumbnail_s3_key: { type: S.STRING(500), allowNull: true },
        content:          { type: S.TEXT('long'), allowNull: true },
        status:           { type: S.ENUM('draft', 'active', 'inactive'), allowNull: false, defaultValue: 'draft' },
        created_by: {
          type: S.INTEGER, allowNull: true,
          references: { model: 'admin_users', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
        },
        created_at: { type: S.DATE, allowNull: false, defaultValue: now },
        updated_at: { type: S.DATE, allowNull: false, defaultValue: now },
      });
    }

    // 2. One version per (frame, language, size). Keyed on a generated column that
    //    maps NULL to 0, or duplicate text-free versions would slip past a plain key.
    if (!(await columnExists(qi, 'frame_versions', 'language_key'))) {
      await qi.sequelize.query(
        'ALTER TABLE `frame_versions` ADD COLUMN `language_key` INT AS (IFNULL(`language_id`, 0)) STORED AFTER `language_id`');
    }
    if (!(await indexExists(qi, 'frame_versions', 'uq_frame_version'))) {
      await qi.addIndex('frame_versions', ['frame_id', 'language_key', 'size_id'], { unique: true, name: 'uq_frame_version' });
    }

    // 3. Copy each frame's design into its first version — only while the columns are
    //    still on frames (a re-run after step 4 has nothing to copy), and only for a
    //    frame that has no version yet.
    if (await columnExists(qi, 'frames', 'content')) {
      const sizeId = await defaultSizeId(qi);
      const frames = await query(qi,
        `SELECT f.id, f.uid, f.name, f.status FROM frames f
          WHERE ((f.content IS NOT NULL AND f.content <> '') OR (f.thumbnail_s3_key IS NOT NULL AND f.thumbnail_s3_key <> ''))
            AND NOT EXISTS (SELECT 1 FROM frame_versions v WHERE v.frame_id = f.id)`);

      for (const f of frames) {
        // Without a size the version cannot be live; the frame then shows nowhere
        // until an admin sets one, which is louder than guessing.
        const status = sizeId ? (f.status === 'active' ? 'active' : 'draft') : 'draft';
        await qi.sequelize.query(
          `INSERT INTO frame_versions (uid, frame_id, language_id, size_id, thumbnail_s3_key, content, status, created_by, created_at, updated_at)
           SELECT UUID(), id, NULL, ?, thumbnail_s3_key, content, ?, created_by, created_at, NOW() FROM frames WHERE id = ?`,
          { replacements: [sizeId, status, f.id] });
        console.log(`[migration 058] frame ${f.uid} ("${f.name}") → one text-free version${sizeId ? '' : ' with NO SIZE (draft)'}. Check its size, and set a language if it has text.`);
      }
      if (frames.length) console.log(`[migration 058] ${frames.length} frame(s) moved to versions — review them in the admin panel.`);
      if (frames.length && !sizeId) console.log('[migration 058] no default size found — every version is a draft and the store is EMPTY until sizes are set.');
    }

    // 4. Drop the moved columns from frames.
    for (const column of MOVED) {
      if (await columnExists(qi, 'frames', column)) await qi.removeColumn('frames', column);
    }

    // 5. Names unique in the database, not only through adminCrud's pre-check.
    if (!(await indexExists(qi, 'frames', 'uq_frame_name'))) {
      await qi.addIndex('frames', ['name'], { unique: true, name: 'uq_frame_name' });
    }
  },

  // Best effort: puts content/thumbnail back on frames from each frame's best
  // version (text-free or English first, then lowest id), then drops the versions.
  // Other versions' designs are lost. migrate:undo:all is broken at 032 anyway.
  async down(queryInterface, Sequelize) {
    const qi = queryInterface;
    const S  = Sequelize;

    if (await indexExists(qi, 'frames', 'uq_frame_name')) await qi.removeIndex('frames', 'uq_frame_name');
    if (!(await columnExists(qi, 'frames', 'thumbnail_s3_key'))) {
      await qi.addColumn('frames', 'thumbnail_s3_key', { type: S.STRING(500), allowNull: true, after: 'description' });
    }
    if (!(await columnExists(qi, 'frames', 'content'))) {
      await qi.addColumn('frames', 'content', { type: S.TEXT('long'), allowNull: true, after: 'thumbnail_s3_key' });
    }
    if (await tableExists(qi, 'frame_versions')) {
      await qi.sequelize.query(
        `UPDATE frames f JOIN frame_versions v ON v.id = (
            SELECT v2.id FROM frame_versions v2 LEFT JOIN languages l ON l.id = v2.language_id
             WHERE v2.frame_id = f.id
             ORDER BY (v2.language_id IS NULL OR l.code = 'en') DESC, v2.id ASC LIMIT 1)
            SET f.content = v.content, f.thumbnail_s3_key = v.thumbnail_s3_key`);
      await qi.dropTable('frame_versions');
    }
  },
};
