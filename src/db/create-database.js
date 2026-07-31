// Creates the target database if it does not exist (CREATE DATABASE cannot be
// expressed as a migration since migrations run inside the database).
require('dotenv').config({ path: `.env.${process.env.NODE_ENV || 'development'}` });
const mysql = require('mysql2/promise');

(async () => {
  const { DB_HOST = 'localhost', DB_PORT = 3306, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  const conn = await mysql.createConnection({
    host: DB_HOST, port: parseInt(DB_PORT, 10), user: DB_USER, password: DB_PASSWORD || undefined,
  });
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  console.log(`[DB] Database '${DB_NAME}' is ready.`);
  await conn.end();
})().catch((err) => { console.error('[DB] create-database failed:', err.message); process.exit(1); });
