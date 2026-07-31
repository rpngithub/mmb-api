// Marks a route as a deprecated alias of a renamed one. The handler still runs
// normally — this only annotates the response so clients can find out they are on an
// old path without anything breaking.
//
// Headers follow RFC 8594 / RFC 8288:
//   Deprecation: true                              — this endpoint is deprecated
//   Link: <successor>; rel="successor-version"     — where to go instead
//   Sunset: <http-date>                            — when it will stop working (optional)
//
// Used for the Theme -> Brand Series / Variant rename: /theme-groups and /themes keep
// answering so the app and admin panel can migrate on their own schedule.
module.exports = (successor, { sunset } = {}) => (req, res, next) => {
  res.set('Deprecation', 'true');
  res.set('Link', `<${successor}>; rel="successor-version"`);
  if (sunset) res.set('Sunset', sunset);
  next();
};
