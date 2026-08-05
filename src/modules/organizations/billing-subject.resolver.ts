import { Injectable } from '@nestjs/common';

import { RequestContext } from '@common/context/request-context';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { FEATURE_FLAGS } from '@modules/feature-flags/feature-flags.catalogue';
import { FeatureFlagsService } from '@modules/feature-flags/feature-flags.service';

import { type BillingSubject, userSubject } from './billing-subject';

/**
 * Decides whether a request bills the calling user or their bound
 * organization. Defaults to the user — org-primary only applies when *all*
 * of the following hold:
 *
 *   1. The request is bound to an organization (`OrganizationContextGuard`
 *      already verified membership before this runs).
 *   2. That organization's `billingMode` is `organization`.
 *   3. The `org.billing` feature flag is enabled for that user/org.
 *
 * See design.md decision 4. `CreditsGuard` and other credit/plan call sites
 * resolve through here rather than trusting a client-supplied subject.
 */
@Injectable()
export class BillingSubjectResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  async resolve(
    userId: string,
    organizationIdOverride?: string,
  ): Promise<BillingSubject> {
    const organizationId =
      organizationIdOverride ?? RequestContext.getOrganizationId();

    if (!organizationId) {
      return userSubject(userId);
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, billingMode: true },
    });

    if (!organization || organization.billingMode !== 'organization') {
      return userSubject(userId);
    }

    const orgBillingEnabled = await this.featureFlags.isEnabled(
      FEATURE_FLAGS.ORG_BILLING,
      { userId, organizationId },
    );

    if (!orgBillingEnabled) {
      return userSubject(userId);
    }

    return { type: 'organization', organizationId };
  }
}
