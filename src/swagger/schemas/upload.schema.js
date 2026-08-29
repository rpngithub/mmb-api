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
 *     BatchPresignResponse:
 *       type: object
 *       description: >-
 *         What a batch request (`files: [...]`) returns. The per-file fields move into
 *         `files`, in the order they were sent; the limits are per ACCOUNT, so they are
 *         reported once rather than repeated on every entry.
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           properties:
 *             files:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   key:              { type: string }
 *                   upload_url:       { type: string }
 *                   required_headers: { type: object, example: { 'x-amz-tagging': 'status=pending' } }
 *             expires_in: { type: integer, example: 900 }
 *             max_bytes:  { type: integer, example: 10485760, description: Per FILE, not per batch. }
 *             storage_remaining:
 *               type: integer
 *               nullable: true
 *               description: >-
 *                 Bytes left for the whole account, not per file — sum the batch's sizes
 *                 against it client-side. null = unlimited (or an unenforced free account).
 *
 *     StorageQuotaResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           properties:
 *             limit_bytes:
 *               type: integer
 *               nullable: true
 *               description: The plan's storage allowance in bytes; null = unlimited or unenforced.
 *             used_bytes:
 *               type: integer
 *               description: Bytes currently stored. Always a real figure, even when no limit applies.
 *             remaining_bytes:
 *               type: integer
 *               nullable: true
 *               description: Headroom in bytes; null when limit_bytes is null. Same value presign reports as storage_remaining. Includes any purchased top-up.
 *             topup_bytes:
 *               type: integer
 *               description: >-
 *                 Capacity bought through a storage top-up, already counted in remaining_bytes.
 *                 Reported separately so a client can say "100 MB plan + 500 MB bought" rather
 *                 than one opaque total. Storage is a level, so freeing a file returns this
 *                 capacity — it is a permanently raised ceiling, not a one-off allowance.
 *             unlimited:
 *               type: boolean
 *               description: Test this rather than checking the nulls.
 *             max_upload_bytes:
 *               type: integer
 *               example: 10485760
 *               description: Per-FILE cap, separate from the allowance. A file over this is refused even with room to spare.
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
 *               description: >-
 *                 The keys now tagged active — CONFIRMED ONES ONLY, so this is safe to save
 *                 straight onto records. Re-confirming an already-confirmed key is a no-op,
 *                 not a double charge, and is reported as confirmed.
 *             results:
 *               type: array
 *               description: >-
 *                 Per-key outcome, in the order sent. A batch is not all-or-nothing: files
 *                 that pass are promoted and charged even when others in the same call are
 *                 rejected. If EVERY key fails the request itself fails instead (400/402),
 *                 so a single-key confirm behaves exactly as it always has.
 *               items:
 *                 type: object
 *                 properties:
 *                   key:    { type: string }
 *                   status: { type: string, enum: [confirmed, rejected] }
 *                   reason: { type: string, description: 'Rejected only — why, in words fit to show the user.' }
 *                   code:
 *                     type: string
 *                     enum: [VALIDATION_ERROR, QUOTA_EXCEEDED]
 *                     description: >-
 *                       Rejected only. QUOTA_EXCEEDED means the account ran out of room
 *                       mid-batch — worth an upgrade prompt rather than a per-file error.
 */
