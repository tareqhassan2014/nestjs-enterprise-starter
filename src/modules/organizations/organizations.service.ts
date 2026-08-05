import { HttpStatus, Injectable } from '@nestjs/common';

import type {
  Organization,
  OrganizationMemberRole,
} from '@/generated/prisma/client';
import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import { PrismaService } from '@infrastructure/prisma/prisma.service';

export interface OrganizationMembershipView {
  organization: Organization;
  role: OrganizationMemberRole;
}

export interface MemberView {
  userId: string;
  role: OrganizationMemberRole;
  createdAt: Date;
}

/** Managers can add/remove members; only `owner` can grant/remove `owner`. */
const MANAGER_ROLES: readonly OrganizationMemberRole[] = ['owner', 'admin'];

/**
 * Minimal organizations + membership. Not a tenancy product — no invitations,
 * no SSO, no branding — just enough for `OrganizationContextGuard` and
 * `BillingSubjectResolver` to have a membership to check. See
 * `openspec/changes/async-cross-cutting-enterprise/design.md` decision 4.
 */
@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    creatorUserId: string,
    params: { name: string; slug: string },
  ): Promise<Organization> {
    const existing = await this.prisma.organization.findUnique({
      where: { slug: params.slug },
    });
    if (existing) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        'An organization with this slug already exists.',
        { slug: params.slug },
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: { name: params.name, slug: params.slug },
      });

      await tx.organizationMember.create({
        data: {
          organizationId: organization.id,
          userId: creatorUserId,
          role: 'owner',
        },
      });

      return organization;
    });
  }

  async listMine(userId: string): Promise<OrganizationMembershipView[]> {
    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId },
      include: { organization: true },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((membership) => ({
      organization: membership.organization,
      role: membership.role,
    }));
  }

  async listMembers(
    actorUserId: string,
    organizationId: string,
  ): Promise<MemberView[]> {
    await this.requireMembership(organizationId, actorUserId);

    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });

    return members.map((member) => ({
      userId: member.userId,
      role: member.role,
      createdAt: member.createdAt,
    }));
  }

  async addMember(
    actorUserId: string,
    organizationId: string,
    params: { userId: string; role?: OrganizationMemberRole },
  ): Promise<MemberView> {
    const actor = await this.requireManager(organizationId, actorUserId);
    const role = params.role ?? 'member';

    if (role === 'owner' && actor.role !== 'owner') {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Only an owner can grant the owner role.',
      );
    }

    await this.assertUserExists(params.userId);

    const member = await this.prisma.organizationMember.upsert({
      where: {
        organizationId_userId: { organizationId, userId: params.userId },
      },
      update: { role },
      create: { organizationId, userId: params.userId, role },
    });

    return {
      userId: member.userId,
      role: member.role,
      createdAt: member.createdAt,
    };
  }

  async removeMember(
    actorUserId: string,
    organizationId: string,
    targetUserId: string,
  ): Promise<void> {
    const actor = await this.requireManager(organizationId, actorUserId);

    const target = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: targetUserId },
      },
    });

    if (!target) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Membership not found.',
      );
    }

    if (target.role === 'owner' && actor.role !== 'owner') {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Only an owner can remove an owner.',
      );
    }

    if (target.role === 'owner') {
      const ownerCount = await this.prisma.organizationMember.count({
        where: { organizationId, role: 'owner' },
      });
      if (ownerCount <= 1) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          'An organization must keep at least one owner.',
        );
      }
    }

    await this.prisma.organizationMember.delete({
      where: {
        organizationId_userId: { organizationId, userId: targetUserId },
      },
    });
  }

  /** Membership row for `userId` in `organizationId`, or null if absent. */
  async getMembership(
    organizationId: string,
    userId: string,
  ): Promise<{ role: OrganizationMemberRole } | null> {
    const member = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true },
    });
    return member;
  }

  private async requireMembership(
    organizationId: string,
    userId: string,
  ): Promise<{ role: OrganizationMemberRole }> {
    const member = await this.getMembership(organizationId, userId);
    if (!member) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'You are not a member of this organization.',
      );
    }
    return member;
  }

  private async requireManager(
    organizationId: string,
    userId: string,
  ): Promise<{ role: OrganizationMemberRole }> {
    const member = await this.requireMembership(organizationId, userId);
    if (!MANAGER_ROLES.includes(member.role)) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Only an owner or admin can manage members.',
      );
    }
    return member;
  }

  private async assertUserExists(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'User not found.',
        { userId },
      );
    }
  }
}
