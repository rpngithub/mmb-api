// Which client an authenticated session belongs to. Recorded on the session as
// `client_type` and carried in the access token's `client_type` claim.
//
// This used to be free text: `client_mnemonic` was `Joi.string().required()`, so a
// caller could send anything of any length. Nothing reads the claim for an
// authorization decision today, which is why an arbitrary value cost nothing — but a
// caller-supplied string that lands inside a JWT is the wrong thing to leave lying
// around. The day something gates on it (an admin-panel-only check, per-client rate
// limits, analytics anyone trusts) the gate is controlled by whoever is calling. It
// also removed a 500: values over 50 characters failed on INSERT against
// `user_sessions.client_type` — after the OTP had already been consumed, so the user
// had to request a new one.
//
// Values are matched exactly, so clients must send them lowercase.
const USER_CLIENT_TYPES = ['android', 'ios', 'web', 'playground'];

// Deliberately NOT in the list above. Admin login sets this server-side, so a
// user-side OTP login cannot mint a token claiming to be the admin panel.
const ADMIN_CLIENT_TYPE = 'admin_panel';

module.exports = { USER_CLIENT_TYPES, ADMIN_CLIENT_TYPE };
