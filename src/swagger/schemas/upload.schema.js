/**
 * Hand-written shapes for the user upload flow. These are not model rows — the
 * presign response is derived per request, and confirm echoes back what it
 * promoted — so they cannot come from modelSchemas.
 *
 * @swagger
 * components:
 *   schemas:
 *     PresignResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           properties:
 *             key:
 *               type: string
 *               example: users/3f1c.../media/9b2e....jpg
 *               description: >-
 *                 The FINAL key, derived from the authenticated caller and the slot —
 *                 never something the client chose. Save this on the record it belongs
 *                 to once confirmed.
 *             upload_url:
 *               type: string
 *               description: Short-lived presigned PUT URL. Upload the raw file body to it.
 *             required_headers:
 *               type: object
 *               description: >-
 *                 Headers the PUT must echo exactly, or S3 rejects the signature. The
 *                 pending tag is what makes an abandoned upload free — the lifecycle rule
 *                 only sweeps objects still tagged pending.
 *               example: { 'x-amz-tagging': 'status=pending' }
 *             expires_in: { type: integer, example: 900, description: Seconds until upload_url stops working }
 *             max_bytes:
 *               type: integer
 *               example: 10485760
 *               description: >-
 *                 Per-file limit, enforced at CONFIRM rather than on the PUT — a presigned
 *                 URL cannot carry a size condition. Check it client-side to avoid uploading
 *                 a file that will be rejected and deleted.
 *             storage_remaining:
 *               type: integer
 *               nullable: true
 *               description: Bytes left in the plan's storage allowance; null = unlimited (or an unenforced free account).
 *
 *     ConfirmUploadResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           properties:
 *             keys:
 *               type: array
 *               items: { type: string }
 *               description: The keys now tagged active. Re-confirming an already-confirmed key is a no-op, not a double charge.
 */
