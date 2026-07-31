const Joi = require('joi');

// content is the editor JSON (stored as-is in template.content). We only check it parses;
// the FE keeps asset references as bare filenames (Pattern 1 resolution at render).
const jsonString = Joi.string().custom((value, helpers) => {
  try { JSON.parse(value); return value; } catch { return helpers.error('any.invalid'); }
}, 'json').messages({ 'any.invalid': 'content must be valid JSON' });

// Both keys are optional but at least one must be present. `thumbnail_filename` alone
// re-points the thumbnail at another file already uploaded under templates/<uid>/ (via
// the presign target { type:'template_file', template_uid }) without re-sending the
// whole bundle; `content` alone re-saves the editor JSON.
const bundleConfirmSchema = Joi.object({
  content:            jsonString.optional(),
  thumbnail_filename: Joi.string().min(1).max(200).optional(),
}).min(1);

module.exports = { bundleConfirmSchema };
