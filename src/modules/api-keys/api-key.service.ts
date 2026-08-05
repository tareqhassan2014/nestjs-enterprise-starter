import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaService } from '@infrastructure/prisma/prisma.service';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';
import {
  type EffectiveAccess,
  PermissionResolver,
} from '@modules/authorization/permission-resolver.service';

/** Public prefix length including `nes_` (4) + 8 hex chars. */
export const API_KEY_PREFIX_LENGTH = 12;
export const API_KEY_SECRET_BYTES = 24;

export interface AgentPrincipal {
  user: AuthenticatedPrincipal;
  apiKeyId: string;
  access: EffectiveAccess;
}

export interface CreatedApiKey {
  id: string;
  name: string;
  prefix: string;
  /** Plaintext secret — returned once on create only. */
  secret: string;
  createdAt: Date;
}

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolver,
  ) {}

  async create(userId: string, name: string): Promise<CreatedApiKey> {
    const secret = this.generateSecret();
    const prefix = secret.slice(0, API_KEY_PREFIX_LENGTH);
    const secretHash = this.hashSecret(secret);

    const row = await this.prisma.apiKey.create({
      data: {
        userId,
        name: name.trim(),
        prefix,
        secretHash,
      },
    });

    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      secret,
      createdAt: row.createdAt,
    };
  }

  async listForUser(userId: string): Promise<ApiKeyView[]> {
    const rows = await this.prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => this.toView(row));
  }

  async revoke(userId: string, keyId: string): Promise<ApiKeyView> {
    const existing = await this.prisma.apiKey.findFirst({
      where: { id: keyId, userId },
    });

    if (!existing) {
      throw new NotFoundException('API key not found.');
    }

    if (existing.revokedAt) {
      return this.toView(existing);
    }

    const row = await this.prisma.apiKey.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });

    return this.toView(row);
  }

  /**
   * Verify `Authorization: Bearer <secret>` and resolve the agent principal.
   * Returns null when the header is missing/malformed/invalid (caller maps to 401).
   */
  async authenticateBearer(
    authorization: string | undefined,
  ): Promise<AgentPrincipal | null> {
    const secret = this.extractBearer(authorization);
    if (!secret) {
      return null;
    }

    return this.verifySecret(secret);
  }

  async verifySecret(secret: string): Promise<AgentPrincipal | null> {
    if (!secret.startsWith('nes_') || secret.length < API_KEY_PREFIX_LENGTH) {
      return null;
    }

    const prefix = secret.slice(0, API_KEY_PREFIX_LENGTH);
    const row = await this.prisma.apiKey.findUnique({ where: { prefix } });

    if (!row || row.revokedAt) {
      return null;
    }

    const candidate = Buffer.from(this.hashSecret(secret), 'hex');
    const stored = Buffer.from(row.secretHash, 'hex');
    if (
      candidate.length !== stored.length ||
      !timingSafeEqual(candidate, stored)
    ) {
      return null;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: row.userId },
    });

    if (!user || !user.emailVerified) {
      return null;
    }

    // Fire-and-forget last-used stamp; verification must not fail on it.
    void this.prisma.apiKey
      .update({
        where: { id: row.id },
        data: { lastUsedAt: new Date() },
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `Failed to stamp api key lastUsedAt: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    const access = await this.permissions.resolve(user.id);

    return {
      apiKeyId: row.id,
      access,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled ?? false,
      },
    };
  }

  private generateSecret(): string {
    return `nes_${randomBytes(API_KEY_SECRET_BYTES).toString('hex')}`;
  }

  private hashSecret(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
  }

  private extractBearer(authorization: string | undefined): string | null {
    if (!authorization?.startsWith('Bearer ')) {
      return null;
    }
    const token = authorization.slice('Bearer '.length).trim();
    return token.length > 0 ? token : null;
  }

  private toView(row: {
    id: string;
    name: string;
    prefix: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
  }): ApiKeyView {
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
    };
  }
}
