#!/usr/bin/env node
/**
 * Makes the value for REVIEW_LOGIN_OTP_HASH (see src/utils/reviewLogin.js).
 *
 *   npm run review:otp-hash              # picks a random 6-digit code
 *   npm run review:otp-hash -- 482913    # hashes the code you give it
 *
 * Prints the code (goes into the Play Console "App access" form, nowhere else) and
 * its bcrypt hash (goes into the server env). Runs locally, offline — no need to
 * paste the code into an online hash tool.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const given = process.argv[2];
if (given !== undefined && !/^\d{6}$/.test(given)) {
  console.error('The code must be exactly 6 digits (the app and the API accept nothing else).');
  process.exit(1);
}

const code = given || String(crypto.randomInt(100000, 1000000));
const hash = bcrypt.hashSync(code, 10);

console.log(`Code (Play Console only): ${code}`);
console.log(`REVIEW_LOGIN_OTP_HASH=${hash}`);
console.log('\nIn a .env file, wrap the hash in single quotes. In the hosting panel, paste it as-is.');
