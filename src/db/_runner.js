// Minimal migration/seeder runner — executes sequelize-cli-format files
// ({ up, down }) using the app's own Sequelize instance, so no sequelize-cli
// install is required. Tracks applied files in a meta table (SequelizeMeta
// for migrations, SequelizeData for seeders), matching the CLI's conventions.
const fs        = require('fs');
const path      = require('path');
const { Sequelize } = require('sequelize');
const sequelize = require('../config/db');

async function ensureMetaTable(table) {
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS \`${table}\` (name VARCHAR(255) NOT NULL PRIMARY KEY) ENGINE=InnoDB`
  );
}

async function appliedNames(table) {
  const [rows] = await sequelize.query(`SELECT name FROM \`${table}\` ORDER BY name`);
  return rows.map((r) => r.name);
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
}

async function run({ dir, table, direction }) {
  const qi = sequelize.getQueryInterface();
  await ensureMetaTable(table);
  const done  = await appliedNames(table);
  const files = listFiles(dir);

  if (direction === 'up') {
    const pending = files.filter((f) => !done.includes(f));
    if (!pending.length) { console.log('  (nothing pending)'); return; }
    for (const f of pending) {
      process.stdout.write(`  up   ${f} ... `);
      await require(path.join(dir, f)).up(qi, Sequelize);
      await sequelize.query(`INSERT INTO \`${table}\` (name) VALUES (?)`, { replacements: [f] });
      console.log('done');
    }
  } else {
    const toUndo = files.filter((f) => done.includes(f)).reverse();
    if (!toUndo.length) { console.log('  (nothing to undo)'); return; }
    for (const f of toUndo) {
      process.stdout.write(`  down ${f} ... `);
      await require(path.join(dir, f)).down(qi, Sequelize);
      await sequelize.query(`DELETE FROM \`${table}\` WHERE name = ?`, { replacements: [f] });
      console.log('done');
    }
  }
}

module.exports = { run, sequelize };
