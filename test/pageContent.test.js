// Unit tests for the two pieces of page-content logic that are pure: the merge
// rule and token substitution. No database — requiring the service constructs a
// Sequelize instance but never connects, and neither function queries.
//
// The HTTP surface (admin CRUD, clone, the public reads) is covered by the
// integration suite in api.test.js, which does need MySQL.
process.env.NODE_ENV = 'test';
require('dotenv').config({ path: '.env.test' });

const test = require('node:test');
const assert = require('node:assert');
const { render, chooseSections } = require('../src/services/pageContent.service');

// Minimal stand-ins for PageSection rows; chooseSections only reads these fields.
const section = (over = {}) => ({
  id: 1, section_key: 'why_choose', business_category_id: null,
  display_order: 0, is_active: 1, ...over,
});

test('chooseSections: a default with no override is served as-is', () => {
  const rows = [section({ id: 1 })];
  assert.deepEqual(chooseSections(rows).map((r) => r.id), [1]);
});

test('chooseSections: an industry override replaces the default for that key only', () => {
  const rows = [
    section({ id: 1, section_key: 'why_choose' }),
    section({ id: 2, section_key: 'content_ideas' }),
    section({ id: 3, section_key: 'content_ideas', business_category_id: 7 }),
  ];
  const out = chooseSections(rows);
  assert.deepEqual(out.map((r) => r.id).sort(), [1, 3]);
  // The untouched key is still the shared default.
  assert.equal(out.find((r) => r.section_key === 'why_choose').business_category_id, null);
});

test('chooseSections: an INACTIVE override hides the inherited default', () => {
  const rows = [
    section({ id: 1, section_key: 'why_choose' }),
    section({ id: 2, section_key: 'why_choose', business_category_id: 7, is_active: 0 }),
  ];
  // This is the case that breaks if you filter before choosing: the default
  // would survive and the block the editor hid would still render.
  assert.deepEqual(chooseSections(rows), []);
});

test('chooseSections: an active override revives an inactive default', () => {
  const rows = [
    section({ id: 1, section_key: 'why_choose', is_active: 0 }),
    section({ id: 2, section_key: 'why_choose', business_category_id: 7, is_active: 1 }),
  ];
  assert.deepEqual(chooseSections(rows).map((r) => r.id), [2]);
});

test('chooseSections: an inactive default with no override simply disappears', () => {
  assert.deepEqual(chooseSections([section({ is_active: 0 })]), []);
});

test('chooseSections: output is ordered by display_order then id, not by scope', () => {
  const rows = [
    section({ id: 1, section_key: 'c', display_order: 30 }),
    section({ id: 2, section_key: 'a', display_order: 10 }),
    section({ id: 3, section_key: 'b', display_order: 10 }),
  ];
  assert.deepEqual(chooseSections(rows).map((r) => r.section_key), ['a', 'b', 'c']);
});

test('chooseSections: override order wins over the default it replaced', () => {
  const rows = [
    section({ id: 1, section_key: 'a', display_order: 10 }),
    section({ id: 2, section_key: 'b', display_order: 20 }),
    section({ id: 3, section_key: 'b', business_category_id: 7, display_order: 5 }),
  ];
  assert.deepEqual(chooseSections(rows).map((r) => r.section_key), ['b', 'a']);
});

test('render: substitutes the industry name', () => {
  const vars = { industry: 'Travel & Tourism', industry_lower: 'travel & tourism' };
  assert.equal(
    render('Create Content for Every {{industry}} Marketing Need', vars),
    'Create Content for Every Travel & Tourism Marketing Need',
  );
  assert.equal(
    render('videos for your {{industry_lower}} brand.', vars),
    'videos for your travel & tourism brand.',
  );
});

test('render: tolerates whitespace and case inside the braces', () => {
  assert.equal(render('for {{ INDUSTRY }} owners', { industry: 'Bakery' }), 'for Bakery owners');
});

test('render: an unresolvable token is removed, not printed', () => {
  // A visitor must never see raw braces on a live page — and the gap the token
  // leaves behind is closed, so this does not read "your  brand".
  assert.equal(render('videos for your {{industry_lower}} brand.', {}), 'videos for your brand.');
  assert.equal(render('{{unknown_token}} leading', { industry: 'X' }), 'leading');
});

test('render: leaves text without tokens untouched, including line breaks', () => {
  const text = 'Line one\nLine two  with  spacing';
  assert.equal(render(text, { industry: 'X' }), text);
});

test('render: passes through null and undefined unchanged', () => {
  assert.equal(render(null, { industry: 'X' }), null);
  assert.equal(render(undefined, { industry: 'X' }), undefined);
});
