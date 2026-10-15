import type {Readable} from 'node:stream';

import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import crypto from 'crypto';
import signale from 'signale';

import {
  S3_ACCESS_KEY_ID,
  S3_ACCESS_KEY_SECRET,
  S3_BUCKET,
  S3_ENABLED,
  S3_ENDPOINT,
  S3_FORCE_PATH_STYLE,
  S3_PRIVATE_BUCKET,
  S3_PUBLIC_URL,
} from '../app/constants.js';

/**
 * S3-compatible storage client for Minio
 */
let s3Client: S3Client | null = null;

if (S3_ENABLED) {
  s3Client = new S3Client({
    region: 'us-east-1', // Minio doesn't use regions, but AWS SDK requires this parameter
    endpoint: S3_ENDPOINT,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_ACCESS_KEY_SECRET,
    },
    forcePathStyle: S3_FORCE_PATH_STYLE, // Required for Minio (uses path-style URLs)
  });
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (('name' in error && (error.name === 'NotFound' || error.name === 'NoSuchKey')) ||
        ('$metadata' in error &&
          error.$metadata &&
          typeof error.$metadata === 'object' &&
          'httpStatusCode' in error.$metadata &&
          error.$metadata.httpStatusCode === 404)),
  );
}

function requireClient(): S3Client {
  if (!s3Client) {
    throw new Error('S3 is not enabled');
  }
  return s3Client;
}

/**
 * Creates the private attachment bucket if it is missing. No policy is ever attached to it, so
 * its objects are readable only with the API's credentials.
 */
export async function initializePrivateBucket(): Promise<void> {
  const client = requireClient();
  try {
    await client.send(new HeadBucketCommand({Bucket: S3_PRIVATE_BUCKET}));
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    await client.send(new CreateBucketCommand({Bucket: S3_PRIVATE_BUCKET}));
    signale.info(`[S3] Created private bucket: ${S3_PRIVATE_BUCKET}`);
  }
}

export async function putPrivateObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await requireClient().send(
    new PutObjectCommand({Bucket: S3_PRIVATE_BUCKET, Key: key, Body: body, ContentType: contentType}),
  );
}

/** Null when the object no longer exists. */
export async function getPrivateObject(key: string): Promise<Readable | null> {
  try {
    const object = await requireClient().send(new GetObjectCommand({Bucket: S3_PRIVATE_BUCKET, Key: key}));
    return (object.Body as Readable | undefined) ?? null;
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

/** Deletes up to 1000 objects per call, the S3 batch limit. */
export async function deletePrivateObjects(keys: string[]): Promise<void> {
  const client = requireClient();
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: S3_PRIVATE_BUCKET,
        Delete: {Objects: batch.map(Key => ({Key})), Quiet: true},
      }),
    );
  }
}

/**
 * Initialize the S3 bucket if it doesn't exist
 */
export async function initializeBucket(): Promise<void> {
  if (!s3Client) {
    throw new Error('S3 is not enabled');
  }

  let bucketExists = true;

  try {
    await s3Client.send(
      new HeadBucketCommand({
        Bucket: S3_BUCKET,
      }),
    );
  } catch (error: unknown) {
    const isNotFoundError =
      error &&
      typeof error === 'object' &&
      (('name' in error && error.name === 'NotFound') ||
        ('$metadata' in error &&
          error.$metadata &&
          typeof error.$metadata === 'object' &&
          'httpStatusCode' in error.$metadata &&
          error.$metadata.httpStatusCode === 404));
    if (isNotFoundError) {
      bucketExists = false;
      // Bucket doesn't exist, create it
      try {
        await s3Client.send(
          new CreateBucketCommand({
            Bucket: S3_BUCKET,
          }),
        );
        signale.info(`[S3] Created bucket: ${S3_BUCKET}`);
      } catch (createError) {
        signale.error('[S3] Failed to create bucket:', createError);
        throw createError;
      }
    } else {
      signale.error('[S3] Failed to check bucket:', error);
      throw error;
    }
  }

  // Set public read policy for the bucket (both for new and existing buckets)
  try {
    const bucketPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'PublicReadGetObject',
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${S3_BUCKET}/*`],
        },
      ],
    };

    await s3Client.send(
      new PutBucketPolicyCommand({
        Bucket: S3_BUCKET,
        Policy: JSON.stringify(bucketPolicy),
      }),
    );

    if (!bucketExists) {
      signale.info(`[S3] Set public read policy for bucket: ${S3_BUCKET}`);
    }
  } catch (policyError) {
    signale.error('[S3] Failed to set bucket policy:', policyError);
    // Don't throw - bucket was created but policy failed
  }
}

interface UploadFileParams {
  file: Buffer;
  filename: string;
  contentType: string;
  projectId: string;
}

interface UploadFileResult {
  url: string;
  key: string;
}

/**
 * Upload a file to S3/Minio
 */
export async function uploadFile(params: UploadFileParams): Promise<UploadFileResult> {
  if (!s3Client) {
    throw new Error('S3 is not enabled');
  }

  const {file, filename, contentType, projectId} = params;

  // Generate a unique key for the file
  const timestamp = Date.now();
  const randomString = crypto.randomBytes(8).toString('hex');
  const extension = filename.split('.').pop();
  const key = `${projectId}/${timestamp}-${randomString}.${extension}`;

  // Upload to S3/Minio
  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: file,
      ContentType: contentType,
    }),
  );

  // Construct public URL
  const url = `${S3_PUBLIC_URL}/${key}`;

  return {url, key};
}

/**
 * Check if S3 is enabled and configured
 */
export function isS3Enabled(): boolean {
  return S3_ENABLED;
}
