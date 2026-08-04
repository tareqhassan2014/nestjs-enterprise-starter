import {
  Body,
  Controller,
  Get,
  Module,
  NotFoundException,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

import { NoEnvelope } from '@common/decorators/no-envelope.decorator';
import { Public } from '@modules/auth/auth.decorators';

class AddressDto {
  @IsString()
  @IsNotEmpty()
  postalCode!: string;
}

class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;
}

class PageQueryDto {
  @IsInt()
  @Min(1)
  page!: number;
}

/**
 * Test-only routes. The contract is global, so it needs *some* endpoint to be
 * observed through; these exist so the e2e suite asserts against real routing,
 * validation, and serialisation rather than mocks.
 */
/**
 * `@Public()` because these fixtures exist to exercise the *envelope and
 * validation* contract, not authentication. Routes are authenticated by default,
 * so without this every assertion in the envelope and validation suites would
 * come back `401` and read as an envelope regression rather than a missing
 * annotation.
 */
@Public()
@Controller('fixture')
export class ContractFixtureController {
  @Get('object')
  object(): { id: string; name: string } {
    return { id: '1', name: 'Ada' };
  }

  @Get('array')
  array(): string[] {
    return ['one', 'two'];
  }

  @Get('void')
  nothing(): void {
    // Intentionally returns nothing.
  }

  @Post('users')
  createUser(@Body() body: CreateUserDto): CreateUserDto {
    return body;
  }

  @Get('paged')
  paged(@Query() query: PageQueryDto): { page: number; type: string } {
    return { page: query.page, type: typeof query.page };
  }

  @Get('boom')
  boom(): never {
    throw new Error(
      'connection string invalid: postgres://user:pw@internal-host',
    );
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException('No such widget');
  }

  @Get('conflict')
  conflict(): never {
    // Shaped exactly like Prisma's known-error class, which the filter
    // duck-types rather than importing.
    const error = new Error('Unique constraint failed on the fields: (`key`)');
    error.name = 'PrismaClientKnownRequestError';
    (error as Error & { code: string }).code = 'P2002';
    throw error;
  }

  @Get('gone')
  gone(): never {
    const error = new Error('An operation failed because it depends on…');
    error.name = 'PrismaClientKnownRequestError';
    (error as Error & { code: string }).code = 'P2025';
    throw error;
  }

  @Get('db-unknown')
  dbUnknown(): never {
    const error = new Error('Raw database detail that must not leak');
    error.name = 'PrismaClientKnownRequestError';
    (error as Error & { code: string }).code = 'P1017';
    throw error;
  }

  @Get('raw')
  @NoEnvelope()
  raw(): { plain: boolean } {
    return { plain: true };
  }

  @Get('raw-boom')
  @NoEnvelope()
  rawBoom(): never {
    throw new NotFoundException('Still enveloped');
  }
}

@Module({ controllers: [ContractFixtureController] })
export class ContractFixtureModule {}
