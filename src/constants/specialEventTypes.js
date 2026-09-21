// The special-event calendar's buckets, as the content team curates them.
// `holiday` is labelled "Public Days" in admin. One list shared by the model
// ENUM, the admin validator and the public `?type=` filter so they cannot
// drift; the DB column (migration 043) is the fourth copy and changes by
// migration only.
const SPECIAL_EVENT_TYPES = ['holiday', 'festival', 'celebration', 'awareness', 'custom'];

module.exports = { SPECIAL_EVENT_TYPES };
