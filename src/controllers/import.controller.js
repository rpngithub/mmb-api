const multer = require('multer');
const importService = require('../services/import.service');
const { ValidationError } = require('../errors');

// CSV upload in memory (small text files). Translate multer's own errors
// (e.g. file too large) into a clean 400 instead of a generic 500.
const _upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
}).single('file');

const uploadCsv = (req, res, next) => _upload(req, res, (err) => {
  if (err) return next(err instanceof multer.MulterError ? new ValidationError(err.message) : err);
  next();
});

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

// Handler factories bound to a specific entity key at route-registration time.
const run = (entity) => async (req, res) => {
  if (!req.file) throw new ValidationError('A CSV file is required in the "file" field (multipart/form-data).');
  const text = req.file.buffer.toString('utf8');
  const result = await importService.runImport(entity, text, { dryRun: truthy(req.body?.dry_run), req });
  res.json({ success: true, data: result });
};

const template = (entity) => (req, res) => {
  const { filename, content } = importService.buildTemplate(entity, { example: truthy(req.query.example) });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + content); // BOM so Excel opens the download as UTF-8
};

module.exports = { uploadCsv, run, template };
