import type { Readable } from 'node:stream';

export interface PutObjectOptions {
  contentType?: string;
}

/**
 * The only way application code touches file storage.
 *
 * An abstract class rather than an interface so it doubles as the DI token —
 * mirrors `MailerService` (see `src/infrastructure/mail/mailer.service.ts`).
 * Consumers inject `ObjectStorage` and never import the S3 SDK or `fs`
 * directly; swapping drivers means changing `STORAGE_DRIVER`, not call sites.
 *
 * Keys are opaque strings the caller owns (e.g. `orgs/{id}/avatar.png`) — this
 * port does not invent a namespace, and there is no automatic public URL.
 * `getSignedUrl` is optional: only the S3 adapter implements it, since a
 * local filesystem has no meaningful pre-signed URL to hand out.
 */
export abstract class ObjectStorage {
  abstract put(
    key: string,
    body: Buffer | Readable,
    opts?: PutObjectOptions,
  ): Promise<void>;

  abstract get(key: string): Promise<Buffer>;

  abstract delete(key: string): Promise<void>;

  getSignedUrl?(key: string, expiresInSeconds: number): Promise<string>;
}
