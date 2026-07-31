require('dotenv').config({ path: `.env.${process.env.NODE_ENV || 'development'}` });
const path = require('path');
const { run, sequelize } = require('./_runner');

const direction = process.argv.includes('--undo') ? 'down' : 'up';

console.log(`[Seed] ${direction === 'up' ? 'Applying' : 'Reverting'} seeders...`);
run({ dir: path.resolve(__dirname, 'seeders'), table: 'SequelizeData', direction })
  .then(() => { console.log('[Seed] Complete.'); return sequelize.close(); })
  .then(() => process.exit(0))
  .catch((err) => { console.error('[Seed] Failed:', err.message); process.exit(1); });
