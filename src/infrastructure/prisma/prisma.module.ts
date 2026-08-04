import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * Global so feature modules inject `PrismaService` without importing a module
 * per feature. Downstream changes must use this client rather than
 * instantiating their own.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
