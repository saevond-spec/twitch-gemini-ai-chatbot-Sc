import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';

function constantTimeEqual(left, right) {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function createEncoderAdminUnlockRouter({ getAdminKey = () => process.env.ENCODER_ADMIN_KEY } = {}) {
  const router = express.Router();
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many unlock attempts. Try again later.' }),
  });

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    next();
  });

  router.post('/unlock', limiter, express.json({ limit: '2kb', strict: true }), (req, res) => {
    let configured;
    try { configured = getAdminKey(); } catch { configured = ''; }
    if (typeof configured !== 'string' || configured.length < 32 || configured.length > 256) {
      return res.status(503).json({ error: 'Admin unlock is not configured.' });
    }

    const supplied = req.body && typeof req.body.key === 'string' ? req.body.key : '';
    if (!supplied || supplied.length > 256 || !constantTimeEqual(supplied, configured)) {
      return res.status(401).json({ error: 'Key not accepted.' });
    }
    return res.status(200).json({ unlocked: true });
  });

  return router;
}
