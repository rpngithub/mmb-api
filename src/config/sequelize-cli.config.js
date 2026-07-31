// Config consumed by sequelize-cli (migrations & seeders).
// Loads the env file matching NODE_ENV, mirroring src/config/db.js settings.
require('dotenv').config({ path: `.env.${process.env.NODE_ENV || 'development'}` });

const shared = {
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD || null,
  database: process.env.DB_NAME,
  host:     process.env.DB_HOST || 'localhost',
  port:     parseInt(process.env.DB_PORT, 10) || 3306,
  dialect:  'mysql',
  define: {
    freezeTableName: true,
    timestamps:      true,
    createdAt:       'created_at',
    updatedAt:       'updated_at',
  },
};

module.exports = {
  development: shared,
  staging:     shared,
  production:  shared,
  test:        shared,
};
