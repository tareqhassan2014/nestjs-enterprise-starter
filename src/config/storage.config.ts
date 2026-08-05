import { registerAs } from '@nestjs/config';

import { getEnv } from './env.validation';

export const storageConfig = registerAs('storage', () => {
  const env = getEnv();

  return {
    driver: env.STORAGE_DRIVER,
    localRoot: env.STORAGE_LOCAL_ROOT,
    s3: {
      bucket: env.STORAGE_S3_BUCKET,
      region: env.STORAGE_S3_REGION,
      accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY,
      endpoint: env.STORAGE_S3_ENDPOINT,
      forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
    },
  };
});

export type StorageConfig = ReturnType<typeof storageConfig>;
