import type { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import { HttpStatus, Injectable, type OnModuleDestroy } from '@nestjs/common';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import type { StorageConfig } from '@config/storage.config';

import { ObjectStorage, type PutObjectOptions } from './object-storage';

@Injectable()
export class S3StorageAdapter extends ObjectStorage implements OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: StorageConfig['s3']) {
    super();

    if (
      !config.bucket ||
      !config.region ||
      !config.accessKeyId ||
      !config.secretAccessKey
    ) {
      // Unreachable in practice: the env schema requires the full S3 group
      // whenever STORAGE_DRIVER=s3. Kept as a named failure rather than a
      // crash inside the AWS SDK if that invariant is ever bypassed.
      throw new Error(
        'S3StorageAdapter requires bucket, region, and credentials — check STORAGE_S3_* env vars.',
      );
    }

    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async put(
    key: string,
    body: Buffer | Readable,
    opts?: PutObjectOptions,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts?.contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      if (!result.Body) {
        throw new ApiException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          'Object not found.',
          { key },
        );
      }

      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (isNoSuchKey(error)) {
        throw new ApiException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          'Object not found.',
          { key },
        );
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return presign(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  /** Releases the S3 client's keep-alive connection pool on shutdown. */
  onModuleDestroy(): void {
    this.client.destroy();
  }
}

function isNoSuchKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { name?: unknown }).name === 'NoSuchKey' ||
      (error as { Code?: unknown }).Code === 'NoSuchKey')
  );
}
