import { Global, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { storageConfig } from '@config/storage.config';

import { LocalStorageAdapter } from './local-storage.adapter';
import { ObjectStorage } from './object-storage';
import { S3StorageAdapter } from './s3-storage.adapter';

/**
 * Binds the `ObjectStorage` port to the adapter `STORAGE_DRIVER` selects.
 * Consumers inject `ObjectStorage` and never learn which one they got —
 * mirrors `MailModule`. Boot-time safety (local rejected in production, S3
 * group completeness) is enforced by the env schema, not repeated here.
 */
@Global()
@Module({
  providers: [
    {
      provide: ObjectStorage,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>): ObjectStorage =>
        config.driver === 's3'
          ? new S3StorageAdapter(config.s3)
          : new LocalStorageAdapter(config.localRoot),
    },
  ],
  exports: [ObjectStorage],
})
export class StorageModule {}
