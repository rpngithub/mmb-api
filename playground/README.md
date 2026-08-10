# API Playground

A browser client for the app-facing MakeMyBrand API, meant for frontend developers who don't
have this repo. No build step, no dependencies — three static files plus a generated `spec.json`.

## Running it

```bash
npm run dev
```

Then open <http://localhost:3000/playground>. `ENABLE_PLAYGROUND=true` is already set in
`.env.development` and `.env.staging`.

The mount is in `src/app.js` and is gated on that variable rather than Swagger's
`NODE_ENV !== 'production'`, because an unset `NODE_ENV` falls back to `.env.development` and would
otherwise expose a live, token-capturing API client on production. Leave it out of
`.env.production`, and remember the Hostinger panel's environment wins over the committed file.

## Before exposing this on staging

Staging should still be behind basic auth or an IP allowlist. `NODE_ENV=staging` is no longer in
`DEV_ENVS` (`src/services/auth.service.js`), so `POST /auth/send-otp` no longer returns the OTP in
the response body and signing in needs the real text — but the playground is a live,
token-capturing client against real staging data either way. `CORS_ORIGINS` does not help here;
CORS is enforced by browsers, not by the server.

## Using it

1. **Auth → Send OTP.** In development the OTP comes back in the response body and is captured
   automatically — no SMS involved (see `src/utils/otpHelper.js`). On staging it is texted for
   real, so read it off the handset and type it into **Verify OTP** yourself.
2. **Auth → Verify OTP.** Captures `access_token`; every other request inherits it as a bearer
   token, so you're signed in for the rest of the session.
3. Anything else, in any order. Ids created along the way (`business_uid`, `project_uid`, …) are
   captured into the **Variables** panel and substituted into later URLs and bodies.

**Run folder** sends every request in a group in order and stops at the first non-2xx. That is the
fastest way to find where a journey breaks — the first red row is the gap.

Variables persist in `localStorage` per browser. **reset** restores the seed values.

### Reading the screen

- `{{var}}` in a URL turns amber when the variable is unset — usually you skipped the request that
  fills it.
- Error responses are rendered from the `{ success:false, error:{ code, message, details } }`
  envelope, with `details` as a field-by-field table.
- **Captured** chips under a response show exactly what got written back into Variables.

## Keeping it current

`spec.json` is generated, and it is the only committed piece of the Postman tooling (`postman/` is
gitignored). Regenerate and commit it whenever routes, payloads or validators change:

```bash
node postman/generate.js
```

That writes the four Postman files plus `playground/spec.json` from the same definitions, so the
playground and the collections never disagree.

## Scope

App endpoints only — 88 requests across Auth, Users, Businesses, Projects, Products, Frames,
Uploads, Fonts, Feedback, Templates, Assets, Catalog, Config and Subscriptions. Admin endpoints are
excluded by design; use the full Postman collection for those.
