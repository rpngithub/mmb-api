const express        = require('express');
const Joi             = require('joi');
const { Op }          = require('sequelize');
const { v4: uuid }    = require('uuid');
const authenticate    = require('../middlewares/authenticate');
const authorizeAdmin  = require('../middlewares/authorizeAdmin');
const validate        = require('../middlewares/validate');
const activity        = require('../services/activity.service');
const slugify         = require('./slugify');
const { NotFoundError, ForbiddenError, ConflictError, ValidationError } = require('../errors');

// Body for PATCH /reorder: the full ordered list of idField values for one
// sibling group. Position in the array becomes the row's display_order.
const reorderSchema = Joi.object({
  ids: Joi.array().items(Joi.alternatives(Joi.string(), Joi.number())).min(1).unique().required(),
});

const STRIP = ['id', 'created_at', 'updated_at'];
const clean = (body) => {
  const out = { ...body };
  for (const k of STRIP) delete out[k];
  return out;
};

/**
 * Builds a standard admin CRUD router for a model, gated per-action by
 * authorizeAdmin(`${permission}.{read|create|update|delete}`) and writing an
 * ActivityLog entry on every mutation.
 *
 * @param {object}  opts
 * @param {Model}   opts.model        Sequelize model
 * @param {string}  opts.resource     singular name used in actions/log (e.g. 'template')
 * @param {string}  opts.permission   permission domain (e.g. 'templates')
 * @param {string} [opts.idField]     lookup field for :id param (default 'uid')
 * @param {boolean}[opts.hasUid]      auto-generate uid on create (default true)
 * @param {string} [opts.softDelete]  column to set 0 instead of destroying
 * @param {object} [opts.createSchema] Joi schema for create
 * @param {object} [opts.updateSchema] Joi schema for update
 * @param {object} [opts.listOptions]  extra findAll options (include/order)
 * @param {function}[opts.protect]     (row) => reason|null; if it returns a string the
 *                                     row is treated as immutable (update/delete -> 403)
 * @param {string[]}[opts.filterable]  query params that filter the list by exact match
 *                                     (e.g. ['plan_id'] -> GET /?plan_id=3). The literal
 *                                     value 'null' filters for SQL NULL, matching the
 *                                     convention in utils/catalogRef.js.
 * @param {object} [opts.filterAlias]  { queryParam: column } map of alternate query-param
 *                                     names that filter a differently-named column
 *                                     (e.g. { industry_id: 'business_category_id' })
 * @param {Array}  [opts.include]      Sequelize include applied to BOTH list and get-one
 *                                     (e.g. nested tags on a category)
 * @param {function}[opts.injectOnCreate] (req) => object merged into the create payload
 *                                     (e.g. stamp created_by from the authenticated admin)
 * @param {function}[opts.beforeWrite] async (payload, row, req) => void — runs after
 *                                     schema validation and the unique check, before the
 *                                     insert/update. `row` is null on create. Throw an
 *                                     AppError to reject the write (e.g. a state-transition
 *                                     guard the Joi schema can't express).
 * @param {boolean}[opts.autoSlug]     when true, derive `slug` from `name` on create if the
 *                                     payload doesn't already carry one (slugify()). The slug is
 *                                     NOT re-derived on update — renaming must not silently break
 *                                     existing slug-based links; pass an explicit slug to change it.
 *                                     Pair with `unique: ['name','slug']` for a clean 409 on clash.
 * @param {string[]}[opts.unique]      columns that must be unique. Checked on create and
 *                                     update (excluding the current row) before writing, so
 *                                     a duplicate yields a clean 409 instead of a raw DB
 *                                     error. Case-sensitivity follows the column collation
 *                                     (MySQL's default *_ci collations make this
 *                                     case-insensitive, e.g. "Help" == "help").
 * @param {boolean}[opts.reorderable]  when true, expose `PATCH /reorder` taking
 *                                     `{ ids: [...] }` (idField values) and writing
 *                                     display_order = array index for each, in one
 *                                     transaction. For tree models (a `parent_id`
 *                                     column) every id in the batch must share the same
 *                                     parent — reorder is sibling-scoped. Requires the
 *                                     model to have a `display_order` column.
 */
function adminCrud(opts) {
  const {
    model, resource, permission, idField = 'uid', hasUid = true,
    softDelete = null, createSchema = null, updateSchema = null, listOptions = {},
    protect = null, filterable = [], include = null, injectOnCreate = null, unique = [],
    autoSlug = false, filterAlias = {}, reorderable = false, beforeWrite = null,
  } = opts;

  const router = express.Router();
  const perm   = permission || resource;
  const find   = (idVal) => model.findOne({ where: { [idField]: idVal }, ...(include ? { include } : {}) });

  // Reject a duplicate value on any `unique` column before insert/update. `excludePk`
  // is the primary key of the row being updated, so a no-op update doesn't collide
  // with itself.
  const assertUnique = async (payload, excludePk) => {
    for (const f of unique) {
      const val = payload[f];
      if (val === undefined || val === null || val === '') continue;
      const where = { [f]: val };
      if (excludePk !== undefined) where.id = { [Op.ne]: excludePk };
      if (await model.findOne({ where })) {
        throw new ConflictError(`A ${resource} with this ${f} already exists`);
      }
    }
  };

  // Every route requires an authenticated admin; per-action permission below.
  router.use(authenticate, authorizeAdmin());

  // Bulk reorder — must be registered before `/:id` so the literal path isn't
  // swallowed by the id param. Assigns display_order = position for each id in a
  // single transaction (all-or-nothing).
  if (reorderable) {
    router.patch('/reorder', authorizeAdmin(`${perm}.update`), validate(reorderSchema), async (req, res) => {
      const { ids } = req.body;
      const rows = await model.findAll({ where: { [idField]: { [Op.in]: ids } } });
      if (rows.length !== ids.length) throw new NotFoundError(`One or more ${resource} ids were not found`);

      // Sibling-scoped: display_order only orders rows within a parent group, so a
      // mixed-parent batch is almost certainly a client bug — reject it.
      if (model.rawAttributes.parent_id) {
        const parents = new Set(rows.map((r) => String(r.parent_id)));
        if (parents.size > 1) throw new ValidationError('All items must belong to the same parent to be reordered together');
      }

      const position = new Map(ids.map((id, i) => [String(id), i]));
      await model.sequelize.transaction((t) =>
        Promise.all(rows.map((r) => r.update({ display_order: position.get(String(r[idField])) }, { transaction: t }))),
      );
      await activity.log(req, { action: `${resource}.reordered`, entityType: resource, metadata: { ids } });
      res.json({ success: true, data: null });
    });
  }

  // The literal string 'null' filters for SQL NULL — the same convention
  // utils/catalogRef.js already uses on the public side (`?parent=null` means
  // top-level). Without it a nullable filter column has no addressable "unset"
  // value: `?business_category_id=null` would compare against the string 'null',
  // which MySQL coerces to 0 and silently matches nothing. That is precisely the
  // rows the page-content editor needs to list — the shared defaults.
  const filterValue = (v) => (v === 'null' ? null : v);

  router.get('/', authorizeAdmin(`${perm}.read`), async (req, res) => {
    const where = {};
    for (const f of filterable) {
      if (req.query[f] !== undefined) where[f] = filterValue(req.query[f]);
    }
    for (const [param, column] of Object.entries(filterAlias)) {
      if (req.query[param] !== undefined) where[column] = filterValue(req.query[param]);
    }
    const rows = await model.findAll({ where, order: [['id', 'DESC']], ...(include ? { include } : {}), ...listOptions });
    res.json({ success: true, data: rows });
  });

  router.get('/:id', authorizeAdmin(`${perm}.read`), async (req, res) => {
    const row = await find(req.params.id);
    if (!row) throw new NotFoundError(`${resource} not found`);
    res.json({ success: true, data: row });
  });

  const createMw = [authorizeAdmin(`${perm}.create`)];
  if (createSchema) createMw.push(validate(createSchema));
  router.post('/', ...createMw, async (req, res) => {
    const payload = clean(req.body);
    if (autoSlug && !payload.slug && payload.name) payload.slug = slugify(payload.name);
    if (unique.length) await assertUnique(payload);
    if (beforeWrite) await beforeWrite(payload, null, req);
    if (hasUid && !payload.uid) payload.uid = uuid();
    if (injectOnCreate) Object.assign(payload, injectOnCreate(req));
    const row = await model.create(payload);
    await activity.log(req, { action: `${resource}.created`, entityType: resource, entityId: row.id });
    res.status(201).json({ success: true, data: row });
  });

  const updateMw = [authorizeAdmin(`${perm}.update`)];
  if (updateSchema) updateMw.push(validate(updateSchema));
  router.patch('/:id', ...updateMw, async (req, res) => {
    const row = await find(req.params.id);
    if (!row) throw new NotFoundError(`${resource} not found`);
    if (protect) { const reason = protect(row); if (reason) throw new ForbiddenError(reason); }
    if (unique.length) await assertUnique(req.body, row.id);
    const patch = clean(req.body);
    if (beforeWrite) await beforeWrite(patch, row, req);
    await row.update(patch);
    await activity.log(req, { action: `${resource}.updated`, entityType: resource, entityId: row.id });
    res.json({ success: true, data: row });
  });

  router.delete('/:id', authorizeAdmin(`${perm}.delete`), async (req, res) => {
    const row = await find(req.params.id);
    if (!row) throw new NotFoundError(`${resource} not found`);
    if (protect) { const reason = protect(row); if (reason) throw new ForbiddenError(reason); }
    if (softDelete) await row.update({ [softDelete]: 0 });
    else await row.destroy();
    await activity.log(req, { action: `${resource}.deleted`, entityType: resource, entityId: row.id });
    res.json({ success: true, data: null });
  });

  return router;
}

module.exports = adminCrud;
