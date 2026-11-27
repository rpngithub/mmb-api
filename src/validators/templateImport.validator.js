const Joi = require('joi');

// Bulk template import (src/services/templateImport.service.js). Shapes only — the
// service does every catalog and file check, and reports them per row.

// ① The manifest as CSV text (the panel reads manifest.csv and sends it as-is).
const createImportSchema = Joi.object({
  label:    Joi.string().max(200).allow('', null).optional(),
  manifest: Joi.string().min(1).max(2 * 1024 * 1024).required(),
});

// ①b A corrected manifest.csv for an import that has not started.
const replaceManifestSchema = Joi.object({
  manifest: Joi.string().min(1).max(2 * 1024 * 1024).required(),
});

// ② Per row: the folder's file list and its design.json text.
const importFilesSchema = Joi.object({
  items: Joi.array().min(1).max(25).required().items(Joi.object({
    row:     Joi.number().integer().min(1).required(),
    files:   Joi.array().max(500).required().items(Joi.object({
      name:         Joi.string().min(1).max(300).required(),
      size:         Joi.number().integer().min(0).required(),
      content_type: Joi.string().max(100).allow('', null).optional(),
    })),
    content: Joi.string().allow('').max(3 * 1024 * 1024).required(),
  })),
});

module.exports = { createImportSchema, replaceManifestSchema, importFilesSchema };
