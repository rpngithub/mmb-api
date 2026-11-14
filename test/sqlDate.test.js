// Raw-SQL dates go in as UTC (utils/sqlDate.js). Without it, Sequelize writes a
// Date replacement in the Node process's LOCAL time while models and the DB
// session are UTC — on an IST machine every raw date window shifts by 5h30.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { QueryTypes } = require('sequelize');

const h = require('./helpers');
const { models } = h;
const { sqlUtc, utcReplacements } = require('../src/utils/sqlDate');

before(async () => { await models.sequelize.authenticate(); });
after(async () => { await models.sequelize.close(); });

// What MySQL makes of a parameter, read back as epoch ms in UTC.
const asSeenByDb = async (param) => {
  const [r] = await models.sequelize.query(
    'SELECT UNIX_TIMESTAMP(CAST(? AS DATETIME(3))) * 1000 AS ms', { replacements: [param], type: QueryTypes.SELECT },
  );
  return Math.round(Number(r.ms));
};

test('sqlUtc: the DB sees the same instant as the Date, whatever this machine\'s timezone', async () => {
  const d = new Date('2026-11-14T10:00:00.000Z');
  assert.equal(sqlUtc(d), '2026-11-14 10:00:00.000');
  assert.equal(await asSeenByDb(sqlUtc(d)), d.getTime(), 'the app session is UTC, so a UTC string is exact');

  // The bug this guards: a bare Date is written in local time. On a UTC host the
  // two agree; anywhere else they differ by exactly the host's offset.
  const offsetMs = -d.getTimezoneOffset() * 60 * 1000;
  assert.equal(await asSeenByDb(d), d.getTime() + offsetMs, 'a raw Date replacement is shifted by the host offset');

  assert.equal(sqlUtc(null), null);
  assert.equal(sqlUtc(undefined), undefined);
  assert.equal(sqlUtc('2026-01-01T00:00:00Z'), '2026-01-01 00:00:00.000');
  assert.throws(() => sqlUtc('not a date'), /not a date/);
});

test('utcReplacements: converts Dates in arrays and objects, leaves everything else (IN lists included)', () => {
  const d = new Date('2026-11-14T10:00:00.000Z');
  assert.deepEqual(utcReplacements([1, d, 'x']), [1, '2026-11-14 10:00:00.000', 'x']);
  assert.deepEqual(utcReplacements({ start: d, ids: [1, 2], n: 3 }), { start: '2026-11-14 10:00:00.000', ids: [1, 2], n: 3 });
  assert.equal(utcReplacements(undefined), undefined);
});
