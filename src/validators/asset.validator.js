const Joi = require('joi');

const { ASSET_TYPES } = require('../utils/assetTypes');

// ---- Assets ----
// `s3_key` is the file itself and is required — an asset IS its file. The
// thumbnail is the public browse image and is optional/clearable ('' or null),
// like every other catalogue thumbnail.
const thumbnailS3Key = Joi.string().max(500).allow(null, '');

const createAssetSchema = Joi.object({
  category_id:      Joi.number().integer().allow(null).optional(),
  name:             Joi.string().min(1).max(200).required(),
  s3_key:           Joi.string().min(1).max(500).required(),
  thumbnail_s3_key: thumbnailS3Key.optional(),
  asset_type:       Joi.string().valid(...ASSET_TYPES).required(),
  is_premium:       Joi.number().valid(0, 1).optional(),
  status:           Joi.string().valid('active', 'inactive').optional(),
});

const updateAssetSchema = Joi.object({
  category_id:      Joi.number().integer().allow(null).optional(),
  name:             Joi.string().min(1).max(200).optional(),
  s3_key:           Joi.string().min(1).max(500).optional(),
  thumbnail_s3_key: thumbnailS3Key.optional(),
  asset_type:       Joi.string().valid(...ASSET_TYPES).optional(),
  is_premium:       Joi.number().valid(0, 1).optional(),
  status:           Joi.string().valid('active', 'inactive').optional(),
}).min(1);

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
  createAssetSchema, updateAssetSchema,
  createAssetCategorySchema, updateAssetCategorySchema,
  setAssetTagsSchema,
};
