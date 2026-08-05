import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { featureFlagsConfig } from '@config/feature-flags.config';
import { PrismaService } from '@infrastructure/prisma/prisma.service';

import {
  FEATURE_FLAG_CODE_DEFAULTS,
  type FeatureFlagKey,
  isFeatureFlagKey,
} from './feature-flags.catalogue';

export interface FeatureFlagContext {
  userId?: string;
  organizationId?: string;
}

/**
 * Resolves a flag in order: user override → organization override → global
 * override → env default → code default. The first row that exists wins —
 * there is no percentage rollout or blending in v1, just narrowing scope.
 *
 * Unknown keys are a fail-closed error rather than a silent `false`: the
 * typed `FeatureFlagKey` parameter already stops this at compile time for
 * every caller in this codebase, so reaching the runtime check means a value
 * arrived from outside the type system (e.g. deserialized config).
 */
@Injectable()
export class FeatureFlagsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(featureFlagsConfig.KEY)
    private readonly config: ConfigType<typeof featureFlagsConfig>,
  ) {}

  async isEnabled(
    key: FeatureFlagKey,
    context: FeatureFlagContext = {},
  ): Promise<boolean> {
    this.assertKnownKey(key);

    if (context.userId) {
      const userOverride = await this.prisma.featureFlagOverride.findFirst({
        where: { flagKey: key, userId: context.userId },
      });
      if (userOverride) {
        return userOverride.enabled;
      }
    }

    if (context.organizationId) {
      const orgOverride = await this.prisma.featureFlagOverride.findFirst({
        where: { flagKey: key, organizationId: context.organizationId },
      });
      if (orgOverride) {
        return orgOverride.enabled;
      }
    }

    const globalOverride = await this.prisma.featureFlagOverride.findFirst({
      where: { flagKey: key, userId: null, organizationId: null },
    });
    if (globalOverride) {
      return globalOverride.enabled;
    }

    const envDefault = (
      this.config.defaults as Partial<Record<FeatureFlagKey, boolean>>
    )[key];
    if (envDefault !== undefined) {
      return envDefault;
    }

    return FEATURE_FLAG_CODE_DEFAULTS[key];
  }

  /**
   * Writes (or replaces) an override at exactly one scope — global, one user,
   * or one org. Concurrent writers may race on first-create (the uniqueness
   * that prevents duplicates is a partial index in the migration, not
   * exercised here through a Prisma-level upsert); acceptable for an
   * infrequent administrative write.
   */
  async setOverride(params: {
    key: FeatureFlagKey;
    enabled: boolean;
    userId?: string;
    organizationId?: string;
  }): Promise<void> {
    this.assertKnownKey(params.key);

    const where = {
      flagKey: params.key,
      userId: params.userId ?? null,
      organizationId: params.organizationId ?? null,
    };

    const existing = await this.prisma.featureFlagOverride.findFirst({
      where,
    });

    if (existing) {
      await this.prisma.featureFlagOverride.update({
        where: { id: existing.id },
        data: { enabled: params.enabled },
      });
      return;
    }

    await this.prisma.featureFlagOverride.create({
      data: {
        flagKey: params.key,
        enabled: params.enabled,
        userId: params.userId,
        organizationId: params.organizationId,
      },
    });
  }

  async clearOverride(params: {
    key: FeatureFlagKey;
    userId?: string;
    organizationId?: string;
  }): Promise<void> {
    this.assertKnownKey(params.key);

    await this.prisma.featureFlagOverride.deleteMany({
      where: {
        flagKey: params.key,
        userId: params.userId ?? null,
        organizationId: params.organizationId ?? null,
      },
    });
  }

  private assertKnownKey(key: string): void {
    if (!isFeatureFlagKey(key)) {
      throw new Error(`Unknown feature flag key: "${key}".`);
    }
  }
}
