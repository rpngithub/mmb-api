'use strict';

const { v4: uuid } = require('uuid');

// Starter language list for the "Preferred Languages" picker. Data, not schema —
// admins add, reorder and deactivate the rest from /admin/languages.
//
// `native_name` is what the picker shows, because that is what a speaker scans
// for. English leads (it is the default for anyone who has not chosen), then the
// most-spoken Indian languages by display_order.
const LANGUAGES = [
  { code: 'en', name: 'English',   native_name: 'English' },
  { code: 'hi', name: 'Hindi',     native_name: 'हिंदी' },
  { code: 'ta', name: 'Tamil',     native_name: 'தமிழ்' },
  { code: 'te', name: 'Telugu',    native_name: 'తెలుగు' },
  { code: 'ml', name: 'Malayalam', native_name: 'മലയാളം' },
  { code: 'kn', name: 'Kannada',   native_name: 'ಕನ್ನಡ' },
  { code: 'mr', name: 'Marathi',   native_name: 'मराठी' },
  { code: 'bn', name: 'Bengali',   native_name: 'বাংলা' },
  { code: 'gu', name: 'Gujarati',  native_name: 'ગુજરાતી' },
  { code: 'pa', name: 'Punjabi',   native_name: 'ਪੰਜਾਬੀ' },
];

module.exports = {
  async up(queryInterface) {
    await queryInterface.bulkInsert('languages', LANGUAGES.map((l, i) => ({
      uid: uuid(),
      ...l,
      display_order: i + 1,
      is_active: 1,
    })));
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('languages', { code: LANGUAGES.map((l) => l.code) }, {});
  },
};
