/**
 * @swagger
 * components:
 *   schemas:
 *     ProjectThumbnailInput:
 *       type: string
 *       example: data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...
 *       description: >-
 *         The project's preview image, INLINE — `canvas.toDataURL('image/jpeg', 0.8)` is
 *         exactly the right thing to send. A data URL or the bare base64 payload; the
 *         declared MIME is ignored and the bytes are sniffed. JPEG, PNG or WebP, at most
 *         500 KB decoded. Stored by the server under the project and returned as
 *         `thumbnail_s3_key`; render `${cdn_base_url}/${thumbnail_s3_key}`.
 *
 *         This is the only way to set a project thumbnail — do not use the presign
 *         flow for it. It does not count against storage quota and never appears in
 *         "My Uploads". Sending the same image again is a no-op (content-addressed).
 */
