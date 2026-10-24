const dashboard = require('../services/dashboard.service');
const { hasPermission } = require('../middlewares/authorizeAdmin');
const { ForbiddenError } = require('../errors');

// GET /admin/dashboard/widgets — only the widgets this admin's role grants.
const listWidgets = async (req, res) => {
  res.json({ success: true, data: dashboard.manifest(req.user.permissions) });
};

// GET /admin/dashboard/widgets/:key — the permission is per widget, so it is
// checked here against the registry rather than by a fixed route middleware.
const getWidget = async (req, res) => {
  const widget = dashboard.getWidget(req.params.key);
  if (!hasPermission(req.user.permissions, widget.permission)) {
    throw new ForbiddenError(`Missing permission: ${widget.permission}`);
  }
  const { data, generated_at, cached } = await dashboard.runWidget(widget, req.query);
  res.json({ success: true, data, meta: { widget: widget.key, generated_at, cached } });
};

module.exports = { listWidgets, getWidget };
