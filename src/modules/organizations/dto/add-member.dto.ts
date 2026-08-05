import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

import type { OrganizationMemberRole } from '@/generated/prisma/client';

export const ASSIGNABLE_MEMBER_ROLES: OrganizationMemberRole[] = [
  'owner',
  'admin',
  'member',
];

export class AddMemberDto {
  @IsString()
  @MinLength(1)
  userId!: string;

  @IsOptional()
  @IsIn(ASSIGNABLE_MEMBER_ROLES)
  role?: OrganizationMemberRole;
}
