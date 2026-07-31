// Prepares the test database: create schema, migrate, seed. Idempotent.
process.env.NODE_ENV = 'test';
require('dotenv').config({ path: '.env.test' });

const path  = require('path');
const mysql = require('mysql2/promise');

async function createDatabase() {
  const { DB_HOST = 'localhost', DB_PORT = 3306, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  const conn = await mysql.createConnection({
    host: DB_HOST, port: parseInt(DB_PORT, 10), user: DB_USER, password: DB_PASSWORD || undefined,
  });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.end();
}

(async () => {
  await createDatabase();
  const { run, sequelize } = require('../src/db/_runner');
  await run({ dir: path.resolve(__dirname, '../src/db/migrations'), table: 'SequelizeMeta', direction: 'up' });
  await run({ dir: path.resolve(__dirname, '../src/db/seeders'),    table: 'SequelizeData', direction: 'up' });
  await sequelize.close();
  console.log('[test] database ready:', process.env.DB_NAME);
})().catch((err) => { console.error('[test] prepare failed:', err.message); process.exit(1); });
