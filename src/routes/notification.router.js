const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/notification.controller');
const authenticate = require('../middlewares/authenticate');
const validate     = require('../middlewares/validate');
const { updateNotificationSettingsSchema } = require('../validators/notification.validator');

/**
 * @swagger
 * tags:
 *   - name: Notifications
 *     description: The signed-in user's notification inbox
 */

/**
 * @swagger
 * /notifications:
 *   get:
 *     summary: List my notifications
 *     description: >-
 *       Newest first. Excludes notifications the user has dismissed, ones that have
 *       expired, and ones still held back by quiet hours — so the list is exactly
 *       what the app should render, with no client-side filtering needed.
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [all, unread] }
 *         description: "`unread` returns only notifications not yet marked read. Default: all."
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *         description: Category slug or uid. An unknown value returns an empty page rather than a 404.
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 50 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: A page of notifications
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       uid:            { type: string, format: uuid }
 *                       title:          { type: string }
 *                       body:           { type: string }
 *                       cta_label:      { type: string, nullable: true }
 *                       cta_action:     { type: string, nullable: true, description: "App route key, e.g. 'subscription.plans'" }
 *                       cta_params:     { type: object, nullable: true }
 *                       image_s3_key:   { type: string, nullable: true }
 *                       priority:       { type: string, enum: [low, normal, high] }
 *                       is_dismissible: { type: boolean }
 *                       is_read:        { type: boolean }
 *                       read_at:        { type: string, format: date-time, nullable: true }
 *                       created_at:     { type: string, format: date-time }
 *                       category:       { type: object, nullable: true }
 *                 meta:
 *                   type: object
 *                   properties: { total: { type: integer } }
 *       401:
 *         description: Not signed in
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/', authenticate, controller.list);

/**
 * @swagger
 * /notifications/summary:
 *   get:
 *     summary: Unread counts for the badge
 *     description: >-
 *       The total unread count plus a per-category breakdown. This is the endpoint
 *       the app polls, so it is served by an index and never fetches rows.
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Unread totals
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     unread_count: { type: integer }
 *                     by_category:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           uid:   { type: string, nullable: true }
 *                           name:  { type: string, nullable: true }
 *                           slug:  { type: string, nullable: true }
 *                           count: { type: integer }
 */
router.get('/summary', authenticate, controller.summary);

/**
 * @swagger
 * /notifications/settings:
 *   get:
 *     summary: My per-category notification settings
 *     description: >-
 *       Every active category with the user's current choice. Categories the user
 *       has never touched come back enabled — a stored row exists only where
 *       something was switched off.
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: One entry per active category
 *   put:
 *     summary: Update my per-category notification settings
 *     description: >-
 *       Muting a category stops everything in it, including transactional
 *       notifications — it is the user asking directly. Channel-level consent
 *       (marketing vs receipts) lives on `PATCH /users/me/preferences` instead.
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [settings]
 *             properties:
 *               settings:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [category_uid, in_app]
 *                   properties:
 *                     category_uid: { type: string, format: uuid }
 *                     in_app:       { type: boolean }
 *     responses:
 *       200:
 *         description: The full updated settings list
 *       404:
 *         description: Unknown category uid
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/settings', authenticate, controller.getSettings);
router.put('/settings', authenticate, validate(updateNotificationSettingsSchema), controller.updateSettings);

/**
 * @swagger
 * /notifications/read-all:
 *   patch:
 *     summary: Mark every visible notification as read
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "How many rows were updated" }
 */
// Registered BEFORE the /:uid routes so the literal path is not captured as a uid.
router.patch('/read-all', authenticate, controller.markAllRead);

/**
 * @swagger
 * /notifications/dismiss-all:
 *   post:
 *     summary: Clear the inbox
 *     description: Dismisses every visible, dismissible notification.
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "How many rows were dismissed" }
 */
router.post('/dismiss-all', authenticate, controller.dismissAll);

/**
 * @swagger
 * /notifications/{uid}/read:
 *   patch:
 *     summary: Mark one notification as read
 *     description: Idempotent, and keeps the original read timestamp on repeat calls.
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: The updated notification }
 *       404:
 *         description: Not found, or not this user's
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.patch('/:uid/read', authenticate, controller.markRead);

/**
 * @swagger
 * /notifications/{uid}/dismiss:
 *   patch:
 *     summary: Dismiss one notification
 *     description: >-
 *       Removes it from the inbox. The row is retained server-side (it still counts
 *       toward send throttling and answers "did we tell them?") until the retention
 *       job prunes it.
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: The dismissal timestamp }
 *       403:
 *         description: This notification is not dismissible
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       404:
 *         description: Not found, or not this user's
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.patch('/:uid/dismiss', authenticate, controller.dismiss);

module.exports = router;
