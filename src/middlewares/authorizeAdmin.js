const { ForbiddenError, AuthError } = require('../errors');

// Permission check for admin actors. A role's `permissions` JSON may contain:
//   '*'           -> superuser, allows everything
//   'templates.*' -> domain wildcard, allows any action in that domain
//   'templates.create' -> exact permission
const authorizeAdmin = (permission) => (req, res, next) => {
  if (!req.user) return next(new AuthError('Not authenticated'));
  if (req.user.actor_type !== 'admin') return next(new ForbiddenError('Admin access required'));

  if (permission) {
    const perms  = req.user.permissions || [];
    const domain = permission.split('.')[0];
    const allowed = perms.includes('*') || perms.includes(permission) || perms.includes(`${domain}.*`);
    if (!allowed) return next(new ForbiddenError(`Missing permission: ${permission}`));
  }

  next();
};

module.exports = authorizeAdmin;
