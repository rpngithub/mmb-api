# MakeMyBrand API (mmb-api)

Backend API — **Node.js + Express 5 + Sequelize (MySQL) + Redis + JWT + Razorpay + S3**.

## Requirements

- **Node.js** >= 18
- **MySQL** running (local XAMPP/WAMP is fine)
- **Redis** running — required to run the server (`npm run dev`/`start`). Not required for the test suite.
- Razorpay keys — required only for live payment calls / webhook round-trips.

## Setup

```bash
npm install

# 1. configure env — edit the file matching your environment
#    .env.development | .env.staging | .env.production | .env.test
#    set DB_*, REDIS_URL, JWT_SECRET, RAZORPAY_* etc.

# 2. create the database, build tables, load baseline data
npm run db:create     # CREATE DATABASE if missing
npm run migrate       # run all migrations (46 tables)
npm run seed          # roles, admin user, plans, categories, settings
```

`NODE_ENV` selects the env file (`.env.<NODE_ENV>`, default `development`).

### Seeded defaults (dev)
- **Admin login:** `admin@makemybrand.com` / `Admin@123` (change outside dev)
- Plans (Free, Pro) + Pro billing options, feature types, business/template categories, public app settings.

## Run

```bash
npm run dev     # nodemon (needs MySQL + Redis up)
npm start       # production start
```

- API base path: `/api/<API_VERSION>` (default `/api/v1`)
- Swagger (non-production): `http://localhost:3000/api/docs`

> If the server fails to boot, it's almost always **Redis not running** or **MySQL creds**. Razorpay keys can be blank — the client is created lazily.

## Database scripts

| Command | Action |
|---|---|
| `npm run db:create` | Create the database if it doesn't exist |
| `npm run migrate` | Apply pending migrations |
| `npm run migrate:undo:all` | Revert all migrations |
| `npm run seed` | Apply seeders |
| `npm run seed:undo` | Revert seeders |
| `npm run db:reset` | Undo migrations → migrate → seed |

> Migrations/seeders are sequelize-cli-format files in `src/db/migrations` and `src/db/seeders`, executed by a small built-in runner (`src/db/_runner.js`) — **no `sequelize-cli` install needed**.

## Tests

Zero-install suite using Node's built-in test runner. Uses a **separate `makemybrand_test` database** and dummy secrets (`.env.test`) — **no Redis or Razorpay required**.

```bash
npm test            # prepare test DB (create+migrate+seed) then run
npm run test:only   # run tests without re-preparing the DB
```

## API surface (high level)

| Area | Base | Auth |
|---|---|---|
| Auth (OTP login, admin login, refresh, logout) | `/api/v1/auth` | public / bearer |
| User profile + billing | `/api/v1/users/me` | bearer |
| Public catalog (categories, templates, themes, tags, sizes, faqs, testimonials, banners, special-events) | `/api/v1/*` | optional (premium unlock + higher rate limit when logged in) |
| Businesses, products, frames, projects, project exports | `/api/v1/{businesses,products,frames,projects}` | bearer (owner-scoped) |
| Subscriptions (plans, coupon verify, initiate, payment verify) | `/api/v1/subscriptions` | bearer |
| Razorpay webhook | `POST /api/v1/subscriptions/webhook` | HMAC signature |
| Admin (RBAC-gated CRUD, user admin, audit log) | `/api/v1/admin/*` | bearer + admin permission |
| Public config | `/api/v1/config` | public |

## Architecture

`routes → middlewares (authenticate / optionalAuth / authorizeAdmin / validate / rateLimiter / quotaCheck) → controllers → services → repositories → Sequelize models`.

- **Auth:** mobile OTP for users, email+password for admins; JWT access/refresh with rotation + blacklist. User tokens carry a `tier` claim (`free`/`paid`).
- **Premium templates:** non-paid viewers get a locked preview (no editable content).
- **Payments:** supports both one-time (Orders API) and recurring (Subscriptions API); the **webhook is the source of truth** (idempotent).
- **Admin:** role-based permissions (`*`, `domain.*`, or exact); every mutation is written to `activity_logs`.
- **Cron jobs:** OTP cleanup, token cleanup, subscription expiry, trending-score recompute (started in `server.js`).

## Notes / known follow-ups

- **Live Razorpay testing** needs real keys, a webhook secret (Razorpay Dashboard → Webhooks), a public tunnel (ngrok), and Redis up.
- **Free-tier quotas** are currently only enforced for users with an active subscription — pending a product decision.
