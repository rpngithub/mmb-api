const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/config.controller');

/**
 * @swagger
 * tags:
 *   - name: Config
 *     description: App configuration (public settings)
 */

/**
 * @swagger
 * /config:
 *   get:
 *     summary: Get public app configuration
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Key-value config object
 */
router.get('/', controller.getConfig);

module.exports = router;
