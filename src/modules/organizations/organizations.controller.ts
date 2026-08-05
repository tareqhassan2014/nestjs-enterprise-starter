import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { CurrentUser } from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';

import { AddMemberDto } from './dto/add-member.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { OrganizationsService } from './organizations.service';

@ApiTags('Organizations')
@Controller({ path: 'organizations', version: '1' })
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Post()
  @Idempotent()
  async create(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() body: CreateOrganizationDto,
  ) {
    return this.organizations.create(user.id, body);
  }

  @Get()
  async listMine(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.organizations.listMine(user.id);
  }

  @Get(':organizationId/members')
  async listMembers(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('organizationId') organizationId: string,
  ) {
    return this.organizations.listMembers(user.id, organizationId);
  }

  @Post(':organizationId/members')
  async addMember(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('organizationId') organizationId: string,
    @Body() body: AddMemberDto,
  ) {
    return this.organizations.addMember(user.id, organizationId, body);
  }

  @Delete(':organizationId/members/:userId')
  @HttpCode(HttpStatus.OK)
  async removeMember(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('organizationId') organizationId: string,
    @Param('userId') userId: string,
  ): Promise<{ removed: true }> {
    await this.organizations.removeMember(user.id, organizationId, userId);
    return { removed: true };
  }
}
