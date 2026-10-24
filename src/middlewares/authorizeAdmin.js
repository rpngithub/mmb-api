const { ForbiddenError, AuthError } = require('../errors');

// Does a role's permission list grant `permission`? A role's `permissions` JSON may contain:
//   '*'           -> superuser, allows everything
//   'templates.*' -> domain wildcard, allows any action in that domain
//   'templates.create' -> exact permission
// Exported so code that decides WHAT to show (the dashboard widget manifest) uses
// the same rule as the middleware that decides what is allowed.
const hasPermission = (perms, permission) => {
  const list   = Array.isArray(perms) ? perms : [];
  const domain = permission.split('.')[0];
  return list.includes('*') || list.includes(permission) || list.includes(`${domain}.*`);
};

const authorizeAdmin = (permission) => (req, res, next) => {
  if (!req.user) return next(new AuthError('Not authenticated'));
  if (req.user.actor_type !== 'admin') return next(new ForbiddenError('Admin access required'));

  if (permission && !hasPermission(req.user.permissions, permission)) {
    return next(new ForbiddenError(`Missing permission: ${permission}`));
  }

  next();
};

module.exports = authorizeAdmin;
module.exports.hasPermission = hasPermission;
