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

import { ApiSessionAuth } from '@infrastructure/openapi/api-session-auth.decorator';
import { CurrentUser } from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';
import { RequirePermissions } from '@modules/authorization/authorization.decorators';
import { StrictThrottle } from '@modules/throttling/throttle.decorators';

import { ApiKeyService } from './api-key.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@ApiTags('Account')
@ApiSessionAuth()
@StrictThrottle()
@RequirePermissions('api-keys:manage')
@Controller({ path: 'account/api-keys', version: '1' })
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeyService) {}

  @Post()
  async create(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() body: CreateApiKeyDto,
  ) {
    return this.apiKeys.create(user.id, body.name);
  }

  @Get()
  async list(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.apiKeys.listForUser(user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async revoke(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    return this.apiKeys.revoke(user.id, id);
  }
}
