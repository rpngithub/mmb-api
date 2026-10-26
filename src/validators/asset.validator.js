const Joi = require('joi');
const { ValidationError } = require('../errors');

const { ASSET_TYPES } = require('../utils/assetTypes');

// ---- Assets ----
// `s3_key` is the file itself and is required — an asset IS its file. The
// thumbnail is the public browse image and is optional/clearable ('' or null),
// like every other catalogue thumbnail.
//
// A VIDEO asset must have one: nothing can be drawn on its card otherwise, and a
// locked premium video would show an empty tile. Required here on create (which
// also covers CSV import); an update that would leave a video without one is
// refused by assertVideoThumbnail below, which can see the stored row.
const thumbnailS3Key = Joi.string().max(500).allow(null, '');

// File metadata the panel reports from the File it uploaded — the server cannot
// decode a video. All optional and nullable.
const metadata = {
  width:        Joi.number().integer().min(1).max(100000).allow(null).optional(),
  height:       Joi.number().integer().min(1).max(100000).allow(null).optional(),
  duration_ms:  Joi.number().integer().min(1).max(24 * 60 * 60 * 1000).allow(null).optional(),
  bytes:        Joi.number().integer().min(0).allow(null).optional(),
  content_type: Joi.string().max(100).allow(null, '').optional(),
};

const createAssetSchema = Joi.object({
  category_id:      Joi.number().integer().allow(null).optional(),
  name:             Joi.string().min(1).max(200).required(),
  s3_key:           Joi.string().min(1).max(500).required(),
  thumbnail_s3_key: Joi.when('asset_type', {
    is:        'video',
    then:      Joi.string().min(1).max(500).required()
      .messages({ 'any.required': 'thumbnail_s3_key is required for a video asset' }),
    otherwise: thumbnailS3Key.optional(),
  }),
  asset_type:       Joi.string().valid(...ASSET_TYPES).required(),
  is_premium:       Joi.number().valid(0, 1).optional(),
  status:           Joi.string().valid('active', 'inactive').optional(),
  ...metadata,
});

const updateAssetSchema = Joi.object({
  category_id:      Joi.number().integer().allow(null).optional(),
  name:             Joi.string().min(1).max(200).optional(),
  s3_key:           Joi.string().min(1).max(500).optional(),
  thumbnail_s3_key: thumbnailS3Key.optional(),
  asset_type:       Joi.string().valid(...ASSET_TYPES).optional(),
  is_premium:       Joi.number().valid(0, 1).optional(),
  status:           Joi.string().valid('active', 'inactive').optional(),
  ...metadata,
}).min(1);

// adminCrud `beforeWrite` for /admin/assets: checks the row as it WILL be, so
// clearing a video's thumbnail, or turning a thumbnail-less asset into a video,
// is refused the same as creating one without.
function assertVideoThumbnail(payload, row) {
  const pick  = (f) => (payload[f] !== undefined ? payload[f] : row && row[f]);
  if (pick('asset_type') === 'video' && !pick('thumbnail_s3_key')) {
    throw new ValidationError('Validation failed', [
      { field: 'thumbnail_s3_key', message: 'thumbnail_s3_key is required for a video asset' },
    ]);
  }
}

// ---- Asset categories (imageless self-ref tree) ----
const createAssetCategorySchema = Joi.object({
  parent_id:     Joi.number().integer().allow(null).optional(),
  name:          Joi.string().min(1).max(100).required(),
  display_order: Joi.number().integer().optional(),
  is_active:     Joi.number().valid(0, 1).optional(),
});

const updateAssetCategorySchema = Joi.object({
  parent_id:     Joi.number().integer().allow(null).optional(),
  name:          Joi.string().min(1).max(100).optional(),
  display_order: Joi.number().integer().optional(),
  is_active:     Joi.number().valid(0, 1).optional(),
}).min(1);

// ---- Asset <-> tag assignment (full replace) ----
const setAssetTagsSchema = Joi.object({
  tag_ids: Joi.array().items(Joi.number().integer()).required(),
});

module.exports = {
  createAssetSchema, updateAssetSchema, assertVideoThumbnail,
  createAssetCategorySchema, updateAssetCategorySchema,
  setAssetTagsSchema,
};
