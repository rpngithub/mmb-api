const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const morgan       = require('morgan');
const rateLimiter  = require('./middlewares/rateLimiter');
const errorHandler = require('./middlewares/errorHandler');

const authRouter         = require('./routes/auth.router');
const userRouter         = require('./routes/user.router');
const businessRouter     = require('./routes/business.router');
const templateRouter     = require('./routes/template.router');
const projectRouter      = require('./routes/project.router');
const subscriptionRouter = require('./routes/subscription.router');
const configRouter       = require('./routes/config.router');
const catalogRouter      = require('./routes/catalog.router');
const productRouter      = require('./routes/product.router');
const frameRouter        = require('./routes/frame.router');
const quotaRouter        = require('./routes/quota.router');
const assetRouter        = require('./routes/asset.router');
const uploadRouter       = require('./routes/upload.router');
const feedbackRouter     = require('./routes/feedback.router');
const fontRouter         = require('./routes/font.router');
const notificationRouter = require('./routes/notification.router');
const adminRouter        = require('./routes/admin.router');
const aiRouter           = require('./routes/ai.router');
const webhookRouter      = require('./routes/aiWebhook.router');

const app = express();

// CORS allowlist from env (comma-separated). When CORS_ORIGINS is unset we
// reflect the request origin (permissive — fine for local dev); in any
// deployed env it should be set so only known frontends are allowed.
const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const corsOptions = corsOrigins.length
  ? {
      origin(origin, callback) {
        // No Origin header = non-browser client (curl, mobile app, server) — allow.
        if (!origin || corsOrigins.includes(origin)) return callback(null, true);
        return callback(null, false); // unknown origin: browser blocks; no 500.
      },
      credentials: true,
    }
  : { origin: true, credentials: true };

app.use(helmet());
app.use(cors(corsOptions));
app.use(morgan(process.env.NODE_ENV === 'development' ? 'dev' : 'combined'));
// Capture the raw body so webhook signatures can be verified against the exact
// bytes Razorpay signed (see razorpayHelper.verifyWebhookSignature).
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

const API_PREFIX = `/api/${process.env.API_VERSION || 'v1'}`;

// Provider callbacks (/webhooks/ai/*) are exempt from the per-IP global limiter:
// a provider finishing a burst of jobs calls from a handful of IPs, and a 429
// there would just make it retry. They are authenticated by signature instead.
const WEBHOOK_PREFIX = `${API_PREFIX}/webhooks/`;
app.use((req, res, next) => (req.path.startsWith(WEBHOOK_PREFIX) ? next() : rateLimiter.global(req, res, next)));

app.use(`${API_PREFIX}/auth`,          authRouter);
app.use(`${API_PREFIX}/users`,         userRouter);
app.use(`${API_PREFIX}/businesses`,    businessRouter);
app.use(`${API_PREFIX}/templates`,     templateRouter);
app.use(`${API_PREFIX}/projects`,      projectRouter);
app.use(`${API_PREFIX}/subscriptions`, subscriptionRouter);
app.use(`${API_PREFIX}/config`,        configRouter);
app.use(`${API_PREFIX}/products`,      productRouter);
app.use(`${API_PREFIX}/frames`,        frameRouter);
app.use(`${API_PREFIX}/quota`,         quotaRouter);
app.use(`${API_PREFIX}/assets`,        assetRouter);
app.use(`${API_PREFIX}/uploads`,       uploadRouter);
app.use(`${API_PREFIX}/feedback`,      feedbackRouter);
app.use(`${API_PREFIX}/fonts`,         fontRouter);
app.use(`${API_PREFIX}/notifications`, notificationRouter);
app.use(`${API_PREFIX}/admin`,         adminRouter);
app.use(`${API_PREFIX}/ai`,            aiRouter);
app.use(`${API_PREFIX}/webhooks`,      webhookRouter);
app.use(`${API_PREFIX}`,               catalogRouter);

// Dev-only SMS diagnostics (POST /dev/test-sms). Unauthenticated and it spends real
// SMS credits, so it needs two things to be true: an explicit opt-in, and an env that
// is not production. The opt-in alone would not be enough — an unset NODE_ENV falls
// back to .env.development, so a copied env file could switch it on where it must
// never exist. Keep ENABLE_SMS_TEST out of .env.staging and .env.production.
// The router itself is mounted outside production only. The SMS endpoint inside it
// keeps its own ENABLE_SMS_TEST opt-in (see dev.router.js) because it is
// unauthenticated and spends real SMS credits — the opt-in alone would not be
// enough, since an unset NODE_ENV falls back to .env.development and a copied env
// file could switch it on where it must never exist. Keep ENABLE_SMS_TEST out of
// .env.staging and .env.production.
//
// The notification tester needs no opt-in: it is authenticated and can only write to
// the caller's own inbox.
if (process.env.NODE_ENV !== 'production') {
  app.use(`${API_PREFIX}/dev`, require('./routes/dev.router'));
  console.log('[Dev] Notification test endpoint mounted at POST ' + `${API_PREFIX}/dev/test-notification`);
  if (process.env.ENABLE_SMS_TEST === 'true') {
    console.log('[Dev] SMS test endpoint mounted at POST ' + `${API_PREFIX}/dev/test-sms`);
  }
  if (process.env.NODE_ENV === 'development') {
    console.log('[Dev] SMTP test endpoint mounted at POST ' + `${API_PREFIX}/dev/test-email`);
  }
}

if (process.env.NODE_ENV !== 'production') {
  const swaggerUi  = require('swagger-ui-express');
  const swaggerSpec = require('./swagger');
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  console.log('[Swagger] Docs available at /api/docs');
}

// Browser playground for frontend devs (see playground/README.md). Deliberately NOT
// gated on `NODE_ENV !== 'production'` like Swagger above: an unset NODE_ENV falls back
// to .env.development, which would mount a live, token-capturing API client on a
// production host. Requiring an explicit opt-in makes a misconfigured deploy fail closed.
if (process.env.ENABLE_PLAYGROUND === 'true') {
  const path = require('path');
  app.use(
    '/playground',
    (req, res, next) => {
      // Scoped to this route only. The playground runs each request's capture script
      // through `new Function`, which helmet's default `script-src 'self'` blocks, and
      // it must be able to call a base URL on another host (a local page pointed at
      // staging), which `connect-src 'self'` blocks.
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src *",
      );
      next();
    },
    express.static(path.join(__dirname, '..', 'playground')),
  );
  console.log('[Playground] Available at /playground');
}

app.use(errorHandler);

module.exports = app;
