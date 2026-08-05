import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Readable } from 'node:stream';

import { HttpStatus, Injectable, Logger } from '@nestjs/common';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';

import { ObjectStorage } from './object-storage';

/**
 * Writes under a configured root directory. Development/test only — the env
 * schema rejects this driver in production (`STORAGE_DRIVER=local` is
 * refused; see `env.schema.ts`), because local disk is not durable across
 * instances or deploys.
 */
@Injectable()
export class LocalStorageAdapter extends ObjectStorage {
  private readonly logger = new Logger(LocalStorageAdapter.name);

  constructor(private readonly root: string) {
    super();
  }

  async put(key: string, body: Buffer | Readable): Promise<void> {
    const filePath = this.resolveKey(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    const data = Buffer.isBuffer(body) ? body : await streamToBuffer(body);
    await writeFile(filePath, data);
  }

  async get(key: string): Promise<Buffer> {
    const filePath = this.resolveKey(key);
    try {
      return await readFile(filePath);
    } catch (error) {
      if (isNotFound(error)) {
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
    const filePath = this.resolveKey(key);
    await rm(filePath, { force: true });
  }

  /**
   * Confines every key under `root`, defeating `../` traversal in caller-
   * supplied keys. Keys are opaque strings owned by callers (see
   * `ObjectStorage`), so this is the one place that must not trust them.
   */
  private resolveKey(key: string): string {
    if (key.trim() === '') {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.BAD_REQUEST,
        'Storage key must not be empty.',
      );
    }

    const resolvedRoot = path.resolve(this.root);
    const resolved = path.resolve(resolvedRoot, key);

    if (
      resolved !== resolvedRoot &&
      !resolved.startsWith(resolvedRoot + path.sep)
    ) {
      this.logger.warn(`Rejected storage key outside root: ${key}`);
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.BAD_REQUEST,
        'Storage key must not escape the storage root.',
        { key },
      );
    }

    return resolved;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  // `Readable`'s async iterator yields `any`; narrowing it here keeps the
  // pushes type-checked.
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
