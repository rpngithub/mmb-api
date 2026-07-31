require('dotenv').config({ path: `.env.${process.env.NODE_ENV || 'development'}` });
const path = require('path');
const { run, sequelize } = require('./_runner');

const direction = process.argv.includes('--undo') ? 'down' : 'up';

console.log(`[Migrate] ${direction === 'up' ? 'Applying' : 'Reverting'} migrations...`);
run({ dir: path.resolve(__dirname, 'migrations'), table: 'SequelizeMeta', direction })
  .then(() => { console.log('[Migrate] Complete.'); return sequelize.close(); })
  .then(() => process.exit(0))
  .catch((err) => { console.error('[Migrate] Failed:', err.message); process.exit(1); });
