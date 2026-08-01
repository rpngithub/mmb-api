// Card-ready shaping for plan_features rows on the public /plans grid.
//
// The pricing card renders one line per feature: a label plus a tick or a greyed
// -out cross. The raw join row can't be rendered directly — `display_label` is an
// optional admin override that is null on most rows, and "included vs not" is
// encoded in `value` differently per data_type. Both are resolved here so the FE
// never has to reproduce the rules.

// The label to print when the admin left display_label blank:
//   boolean          -> the feature label alone ("WhatsApp Stickers")
//   integer, 0       -> the label alone (the card greys the row out)
//   integer, -1      -> "Unlimited Downloads"
//   integer, > 0     -> "500 AI BG remover credits"
// The FeatureType label is used verbatim (no case fiddling) — it carries
// acronyms like "AI" that any auto-casing would mangle.
function deriveLabel(label, value, dataType) {
  if (dataType === 'boolean' || value === 0) return label;
  if (value === -1) return `Unlimited ${label}`;
  return `${value} ${label}`;
}

// One plan_feature row (with its FeatureType included) -> card feature.
function toCardFeature(pf) {
  const ft       = pf.FeatureType || {};
  const dataType = ft.data_type || 'integer';
  const label    = ft.label || '';
  const value    = Number(pf.value);
  const override = typeof pf.display_label === 'string' ? pf.display_label.trim() : '';

  return {
    key:           ft.key,
    label,
    display_label: override || deriveLabel(label, value, dataType),
    value,
    data_type:     dataType,
    enabled:       dataType === 'boolean' ? value === 1 : value !== 0,
    unlimited:     dataType !== 'boolean' && value === -1,
    display_order: pf.display_order ?? 0,
  };
}

// Rows without a FeatureType are orphans (the type was deleted) and have no
// label to render, so they are dropped rather than shown blank. Sorting happens
// here because Sequelize can't ORDER BY a nested include alongside the parent.
function toCardFeatures(rows) {
  return (rows || [])
    .filter((pf) => pf.FeatureType)
    .map(toCardFeature)
    .sort((a, b) => a.display_order - b.display_order);
}

module.exports = { toCardFeature, toCardFeatures };
