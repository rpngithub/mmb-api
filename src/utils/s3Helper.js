const {
  PutObjectCommand, DeleteObjectCommand, GetObjectCommand, CopyObjectCommand,
  PutObjectTaggingCommand, CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
  ListObjectsV2Command, DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const s3 = require('../config/s3');

const BUCKET = process.env.S3_BUCKET_NAME;
const PENDING_TAG = 'status=pending';

const uploadFile = (key, buffer, mimeType) =>
  s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: mimeType }));

// Presigned GET (download) — kept for any read-side use.
const getPresignedUrl = (key, expiresIn = 3600) =>
  getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });

// Presigned PUT (direct browser upload) straight to the FINAL key, tagged status=pending.
// The client must echo the tag as header `x-amz-tagging: status=pending`.
const getPresignedPutUrl = (key, contentType, { tagging = PENDING_TAG, expiresIn = 900 } = {}) =>
  getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType, Tagging: tagging }),
    // Keep x-amz-tagging as a SIGNED header instead of hoisting it to the query string;
    // otherwise the client's `x-amz-tagging` header is unsigned and S3 returns AccessDenied.
    { expiresIn, unhoistableHeaders: new Set(['x-amz-tagging']) },
  );

// Promote a pending object to active by flipping its tag (no byte copy).
const putObjectTagging = (key, status = 'active') =>
  s3.send(new PutObjectTaggingCommand({
    Bucket: BUCKET, Key: key, Tagging: { TagSet: [{ Key: 'status', Value: status }] },
  }));

// ---- Multipart (large files) ----
const createMultipartUpload = (key, contentType, { tagging = PENDING_TAG } = {}) =>
  s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key, ContentType: contentType, Tagging: tagging }))
    .then((r) => r.UploadId);

const presignUploadPart = (key, uploadId, partNumber, expiresIn = 3600) =>
  getSignedUrl(
    s3,
    new UploadPartCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn },
  );

const completeMultipartUpload = (key, uploadId, parts) =>
  s3.send(new CompleteMultipartUploadCommand({
    Bucket: BUCKET, Key: key, UploadId: uploadId,
    MultipartUpload: { Parts: parts.map((p) => ({ ETag: p.etag, PartNumber: p.part_number })) },
  }));

const abortMultipartUpload = (key, uploadId) =>
  s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId }));

// ---- Listing / bulk delete (used for template-bundle reset + tag-flip-all) ----
async function listKeys(prefix) {
  const keys = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents || []) keys.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function deleteObjects(keys) {
  if (!keys.length) return;
  // DeleteObjects caps at 1000 keys per request.
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000).map((Key) => ({ Key }));
    await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: batch } }));
  }
}

const deleteByPrefix = async (prefix) => deleteObjects(await listKeys(prefix));

const deleteFile = (key) =>
  s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));

// CopyObject retained for any ad-hoc use; not part of the upload flow anymore.
const copyObject = (srcKey, destKey) =>
  s3.send(new CopyObjectCommand({ Bucket: BUCKET, CopySource: `${BUCKET}/${srcKey}`, Key: destKey }));

module.exports = {
  uploadFile, getPresignedUrl, getPresignedPutUrl, putObjectTagging,
  createMultipartUpload, presignUploadPart, completeMultipartUpload, abortMultipartUpload,
  listKeys, deleteObjects, deleteByPrefix, copyObject, deleteFile,
};
