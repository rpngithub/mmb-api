const service = require('../services/templateImport.service');

// Bulk template import. Every handler is a thin wrapper: the service owns the
// state machine and the per-row report.
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

const manifestTemplate = (req, res) => {
  const { filename, content } = service.manifestTemplate({ example: truthy(req.query.example) });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + content);
};

const list = async (req, res) => {
  const { rows, count } = await service.listBatches(req.query);
  res.json({ success: true, data: rows, meta: { total: count } });
};

const get      = async (req, res) => ok(res, await service.getBatch(req.params.uid));
const create   = async (req, res) => ok(res, await service.createBatch(req.body, req), 201);
const replaceManifest = async (req, res) => ok(res, await service.replaceManifest(req.params.uid, req.body, req));
const files    = async (req, res) => ok(res, await service.attachFiles(req.params.uid, req.body, req));
const start    = async (req, res) => ok(res, await service.startBatch(req.params.uid, req));
const presign  = async (req, res) => ok(res, await service.presignItem(req.params.uid, req.params.row, req));
const complete = async (req, res) => ok(res, await service.completeItem(req.params.uid, req.params.row, req));
const finalize = async (req, res) => ok(res, await service.finalizeBatch(req.params.uid, req));
const cancel   = async (req, res) => ok(res, await service.cancelBatch(req.params.uid, req));

module.exports = { manifestTemplate, list, get, create, replaceManifest, files, start, presign, complete, finalize, cancel };
