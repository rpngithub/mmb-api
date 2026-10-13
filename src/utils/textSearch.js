const { ValidationError } = require('../errors');

// Shared helpers for plain-text (LIKE-based) search.

const MIN_QUERY = 2;
const MAX_QUERY = 100;
const MAX_WORDS = 8;

// Escape LIKE's own wildcards so a user typing "50%" or "my_brand" searches for
// those characters rather than matching anything. MySQL/MariaDB's default LIKE
// escape character is the backslash, so it is escaped first.
const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

// `%term%` for Op.like — the substring pattern with the term's wildcards escaped.
const containsPattern = (s) => `%${escapeLike(s)}%`;

/**
 * Normalize a free-text query into the phrase and the words to match.
 *
 * Returns null when there is nothing to search for (absent, blank, or shorter than
 * MIN_QUERY), so a stray one-letter keystroke does not count as a search. Longer
 * than MAX_QUERY is a 400 rather than a silent truncation. Words are de-duplicated
 * case-insensitively, one-character words are dropped when longer ones exist (they
 * would match nearly everything), and only the first MAX_WORDS are kept.
 */
function parseSearchQuery(q) {
  if (q === undefined || q === null) return null;
  const phrase = String(Array.isArray(q) ? q[0] : q).trim().replace(/\s+/g, ' ');
  if (phrase.length < MIN_QUERY) return null;
  if (phrase.length > MAX_QUERY) {
    throw new ValidationError(`q must be at most ${MAX_QUERY} characters`);
  }

  const seen = new Set();
  let words = phrase.split(' ').filter((w) => {
    const k = w.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (words.some((w) => w.length > 1)) words = words.filter((w) => w.length > 1);
  return { phrase, words: words.slice(0, MAX_WORDS) };
}

// ---- Per-record keyword lists (template_families.search_keywords) ----

const KEYWORD_MAX     = 50;
const KEYWORDS_MAX    = 30;
const KEYWORDS_STORED = 1000;

// An array or a comma/newline-separated string → trimmed, whitespace-collapsed,
// case-insensitively de-duplicated keywords, in the order given. Commas separate
// keywords, so none can contain one.
function normalizeKeywords(input) {
  if (input === undefined || input === null) return [];
  const parts = (Array.isArray(input) ? input : [input])
    .flatMap((x) => String(x).split(/[,\n]/))
    .map((x) => x.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  const seen = new Set();
  return parts.filter((k) => {
    const key = k.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Stored form: comma-joined, or null for none.
const keywordsToColumn = (input) => {
  const list = normalizeKeywords(input);
  return list.length ? list.join(',') : null;
};

const keywordsFromColumn = (value) => (value ? String(value).split(',').filter(Boolean) : []);

module.exports = {
  escapeLike, containsPattern, parseSearchQuery,
  normalizeKeywords, keywordsToColumn, keywordsFromColumn,
  MIN_QUERY, MAX_QUERY, KEYWORD_MAX, KEYWORDS_MAX, KEYWORDS_STORED,
};
