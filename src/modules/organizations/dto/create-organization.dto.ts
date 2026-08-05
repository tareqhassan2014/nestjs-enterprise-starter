import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateOrganizationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  /** Stable, URL-safe identifier. Lowercase letters, digits, and hyphens only. */
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message:
      'slug must be lowercase letters, digits, and hyphens (e.g. "acme-corp")',
  })
  slug!: string;
}
