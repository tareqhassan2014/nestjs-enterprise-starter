import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './redis.health';
import { ShutdownState } from './shutdown-state.service';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [RedisHealthIndicator, ShutdownState],
  exports: [ShutdownState],
})
export class HealthModule {}
