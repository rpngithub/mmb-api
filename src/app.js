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
const assetRouter        = require('./routes/asset.router');
const adminRouter        = require('./routes/admin.router');

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
app.use(rateLimiter.global);

const API_PREFIX = `/api/${process.env.API_VERSION || 'v1'}`;

app.use(`${API_PREFIX}/auth`,          authRouter);
app.use(`${API_PREFIX}/users`,         userRouter);
app.use(`${API_PREFIX}/businesses`,    businessRouter);
app.use(`${API_PREFIX}/templates`,     templateRouter);
app.use(`${API_PREFIX}/projects`,      projectRouter);
app.use(`${API_PREFIX}/subscriptions`, subscriptionRouter);
app.use(`${API_PREFIX}/config`,        configRouter);
app.use(`${API_PREFIX}/products`,      productRouter);
app.use(`${API_PREFIX}/frames`,        frameRouter);
app.use(`${API_PREFIX}/assets`,        assetRouter);
app.use(`${API_PREFIX}/admin`,         adminRouter);
app.use(`${API_PREFIX}`,               catalogRouter);

if (process.env.NODE_ENV !== 'production') {
  const swaggerUi  = require('swagger-ui-express');
  const swaggerSpec = require('./swagger');
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  console.log('[Swagger] Docs available at /api/docs');
}

app.use(errorHandler);

module.exports = app;
