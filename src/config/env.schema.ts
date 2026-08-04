import { z } from 'zod';

const postgresUrl = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.startsWith('postgresql://') || value.startsWith('postgres://'),
    { message: 'must be a PostgreSQL connection string (postgresql://…)' },
  );

const redisUrl = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
    { message: 'must be a Redis connection string (redis://… or rediss://…)' },
  );

/**
 * `.env` values always arrive as strings, so `z.coerce.boolean()` is unusable —
 * it treats every non-empty string, including `"false"`, as `true`.
 */
const booleanFlag = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .default(defaultValue)
    .transform((value) =>
      typeof value === 'boolean' ? value : value === 'true' || value === '1',
    );

/**
 * A blank assignment (`GOOGLE_CLIENT_ID=`) means "not configured", not "the
 * empty string". `.env.example` ships optional variables as blank placeholders,
 * so without this a fresh `cp .env.example .env` would fail the group checks
 * with an empty value present rather than absent.
 */
const blankAsAbsent = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(
  blankAsAbsent,
  z.string().min(1).optional(),
);

const optionalPort = z.preprocess(
  blankAsAbsent,
  z.coerce.number().int().positive().max(65535).optional(),
);

const httpUrl = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'must be an absolute http(s) URL (https://api.example.com)' },
  );

/**
 * Comma-separated browser origins, e.g. `https://app.example.com,http://localhost:5173`.
 *
 * A wildcard is rejected outright rather than accepted and quietly broken:
 * credentialed CORS and `*` are incompatible, so the browser would reject the
 * response anyway. Failing here turns a confusing integration-time console
 * error into a named boot failure. See the `http-security` capability.
 */
const originList = z
  .string()
  .default('')
  .superRefine((value, ctx) => {
    if (value.trim() === '') {
      return;
    }

    for (const raw of value.split(',')) {
      const origin = raw.trim().replace(/\/$/, '');

      if (origin === '') {
        continue;
      }

      if (origin === '*') {
        ctx.addIssue({
          code: 'custom',
          message:
            'must not be "*" — credentialed CORS cannot use a wildcard origin; list explicit origins instead',
        });
        continue;
      }

      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: `"${origin}" is not a valid origin (expected scheme://host[:port])`,
        });
        continue;
      }

      if (url.origin !== origin) {
        ctx.addIssue({
          code: 'custom',
          message: `"${origin}" must be a bare origin with no path, query, or fragment`,
        });
      }
    }
  })
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim().replace(/\/$/, ''))
      .filter((origin) => origin !== ''),
  );

/**
 * The placeholder shipped in `.env.example`. Long enough to satisfy the length
 * rule so a fresh clone boots, and rejected in production below so it cannot be
 * deployed by accident.
 */
export const PLACEHOLDER_AUTH_SECRET =
  'change-me-to-a-random-32-char-minimum-secret';

const envObjectSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,

  /** Per-dependency timeout for readiness checks, so a hung dependency cannot hang the probe. */
  HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  /**
   * Signs session cookies and tokens. No default in any environment, matching
   * the treatment of connection strings.
   */
  BETTER_AUTH_SECRET: z.string().min(32),

  /**
   * Public base URL of this service. Verification and reset links are built
   * from it, and its scheme decides whether cookies are marked `Secure` and
   * whether HSTS is emitted — one source of truth that cannot disagree with how
   * the service is actually reached. Deliberately undefaulted: a localhost
   * default in production would mail out unreachable links.
   */
  APP_URL: httpUrl,

  SESSION_EXPIRES_IN_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 7),
  SESSION_UPDATE_AGE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24),

  AUTH_MIN_PASSWORD_LENGTH: z.coerce.number().int().min(8).default(12),
  AUTH_MAX_PASSWORD_LENGTH: z.coerce.number().int().max(256).default(128),

  AUTH_VERIFICATION_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60),
  AUTH_RESET_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60),

  /** Shown by authenticator apps next to the account. */
  AUTH_TOTP_ISSUER: z.string().min(1).default('NestJS Enterprise Starter'),

  /**
   * OAuth provider credentials. Optional as a *group*: absent disables the
   * provider, and a half-supplied group fails validation below. There is
   * deliberately no `*_ENABLED` flag that could contradict the credentials.
   */
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  APPLE_CLIENT_ID: optionalString,
  APPLE_CLIENT_SECRET: optionalString,

  // ---------------------------------------------------------------------------
  // Auth abuse resistance
  // ---------------------------------------------------------------------------

  AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),

  /** Applies to sign-in, sign-up, password reset, and 2FA verification. */
  AUTH_STRICT_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(300),
  AUTH_STRICT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  AUTH_LOCKOUT_THRESHOLD: z.coerce.number().int().positive().default(5),
  AUTH_LOCKOUT_BASE_DELAY_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(30),
  AUTH_LOCKOUT_MAX_DELAY_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(900),
  AUTH_LOCKOUT_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),

  // ---------------------------------------------------------------------------
  // Nest request throttling (burst + per-minute; stricter on account routes)
  // ---------------------------------------------------------------------------

  THROTTLE_BURST_WINDOW_SECONDS: z.coerce.number().int().positive().default(10),
  THROTTLE_BURST_MAX: z.coerce.number().int().positive().default(20),
  THROTTLE_MINUTE_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  THROTTLE_MINUTE_MAX: z.coerce.number().int().positive().default(120),

  THROTTLE_STRICT_BURST_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  THROTTLE_STRICT_BURST_MAX: z.coerce.number().int().positive().default(10),
  THROTTLE_STRICT_MINUTE_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  THROTTLE_STRICT_MINUTE_MAX: z.coerce.number().int().positive().default(30),

  // ---------------------------------------------------------------------------
  // Daily / weekly usage ceilings (UTC calendar periods)
  // ---------------------------------------------------------------------------

  USAGE_LIMIT_DEFAULT_DAILY: z.coerce.number().int().positive().default(1_000),
  USAGE_LIMIT_DEFAULT_WEEKLY: z.coerce.number().int().positive().default(5_000),
  USAGE_LIMIT_DEMO_DAILY: z.coerce.number().int().positive().default(100),
  USAGE_LIMIT_DEMO_WEEKLY: z.coerce.number().int().positive().default(500),

  // ---------------------------------------------------------------------------
  // Transport security
  // ---------------------------------------------------------------------------

  CORS_ORIGINS: originList,

  /**
   * Whether to believe `X-Forwarded-For`. Off by default: trusting it blindly
   * lets any client forge its own rate-limit identity. Drives both Express's
   * `trust proxy` setting and the auth library's address headers.
   */
  TRUST_PROXY: booleanFlag(false),

  // ---------------------------------------------------------------------------
  // Outbound mail
  // ---------------------------------------------------------------------------

  /** `log` records messages without delivering; rejected in production below. */
  MAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
  MAIL_FROM: z.string().min(1).default('no-reply@localhost'),

  SMTP_HOST: optionalString,
  SMTP_PORT: optionalPort,
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_SECURE: booleanFlag(false),
});

type EnvShape = z.infer<typeof envObjectSchema>;

/** Members of each all-or-nothing credential group, keyed by display name. */
const CREDENTIAL_GROUPS: Record<string, readonly (keyof EnvShape)[]> = {
  'Google OAuth': ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  'Apple OAuth': ['APPLE_CLIENT_ID', 'APPLE_CLIENT_SECRET'],
};

const SMTP_GROUP = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASSWORD',
] as const;

/**
 * The single source of truth for every environment variable the application
 * reads. Anything not declared here is ignored, and `.env.example` is checked
 * against this schema in CI (`pnpm check:env`).
 *
 * Defaults are only permitted for values that are safe to default. Secrets and
 * connection strings deliberately have none, so their absence fails the boot.
 *
 * Cross-field rules live in the refinement below rather than in consumers, so a
 * half-configured provider or an unsafe production setting fails before a port
 * is bound. Note that a refinement runs only once every field parses, so a
 * missing `DATABASE_URL` is reported before any group rule is evaluated.
 */
export const envSchema = envObjectSchema.superRefine((env, ctx) => {
  // All-or-nothing credential groups: absent disables the provider, partial is a bug.
  for (const [groupName, members] of Object.entries(CREDENTIAL_GROUPS)) {
    const supplied = members.filter((name) => env[name] !== undefined);

    if (supplied.length === 0 || supplied.length === members.length) {
      continue;
    }

    for (const name of members) {
      if (env[name] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `is required because ${groupName} is partially configured — supply every variable in the group (${members.join(', ')}) or none of them`,
        });
      }
    }
  }

  if (env.MAIL_TRANSPORT === 'smtp') {
    for (const name of SMTP_GROUP) {
      if (env[name] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `is required because MAIL_TRANSPORT is "smtp" — supply every variable in the group (${SMTP_GROUP.join(', ')})`,
        });
      }
    }
  }

  // A transport that discards mail would make sign-up appear to succeed while
  // every verification and reset message vanished, leaving unreachable accounts.
  if (env.MAIL_TRANSPORT === 'log' && env.NODE_ENV === 'production') {
    ctx.addIssue({
      code: 'custom',
      path: ['MAIL_TRANSPORT'],
      message:
        'must not be "log" in production — that transport records messages instead of delivering them, so verification and reset mail would silently never arrive. Set MAIL_TRANSPORT=smtp.',
    });
  }

  // Shipping the example placeholder would mean signing every session with a
  // publicly known key.
  if (
    env.NODE_ENV === 'production' &&
    env.BETTER_AUTH_SECRET === PLACEHOLDER_AUTH_SECRET
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['BETTER_AUTH_SECRET'],
      message:
        'must not be the placeholder value from .env.example in production — generate a unique secret (openssl rand -base64 32)',
    });
  }

  if (env.AUTH_MIN_PASSWORD_LENGTH > env.AUTH_MAX_PASSWORD_LENGTH) {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_MIN_PASSWORD_LENGTH'],
      message: 'must not exceed AUTH_MAX_PASSWORD_LENGTH',
    });
  }

  if (
    env.AUTH_LOCKOUT_BASE_DELAY_SECONDS > env.AUTH_LOCKOUT_MAX_DELAY_SECONDS
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_LOCKOUT_BASE_DELAY_SECONDS'],
      message: 'must not exceed AUTH_LOCKOUT_MAX_DELAY_SECONDS',
    });
  }

  // The credential paths must actually be stricter than the general surface, so
  // the guarantee holds for edited values and not only for the defaults.
  const generalRate =
    env.AUTH_RATE_LIMIT_MAX / env.AUTH_RATE_LIMIT_WINDOW_SECONDS;
  const strictRate =
    env.AUTH_STRICT_RATE_LIMIT_MAX / env.AUTH_STRICT_RATE_LIMIT_WINDOW_SECONDS;

  if (strictRate >= generalRate) {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_STRICT_RATE_LIMIT_MAX'],
      message: `must permit a lower rate than the general auth limit (currently ${strictRate.toFixed(3)}/s strict vs ${generalRate.toFixed(3)}/s general) — credential endpoints are meant to be the tighter ones`,
    });
  }

  // Nest account routes must be stricter than the default Nest ceilings.
  const nestBurstRate =
    env.THROTTLE_BURST_MAX / env.THROTTLE_BURST_WINDOW_SECONDS;
  const nestStrictBurstRate =
    env.THROTTLE_STRICT_BURST_MAX / env.THROTTLE_STRICT_BURST_WINDOW_SECONDS;

  if (nestStrictBurstRate >= nestBurstRate) {
    ctx.addIssue({
      code: 'custom',
      path: ['THROTTLE_STRICT_BURST_MAX'],
      message: `must permit a lower rate than the default burst limit (currently ${nestStrictBurstRate.toFixed(3)}/s strict vs ${nestBurstRate.toFixed(3)}/s default)`,
    });
  }

  const nestMinuteRate =
    env.THROTTLE_MINUTE_MAX / env.THROTTLE_MINUTE_WINDOW_SECONDS;
  const nestStrictMinuteRate =
    env.THROTTLE_STRICT_MINUTE_MAX / env.THROTTLE_STRICT_MINUTE_WINDOW_SECONDS;

  if (nestStrictMinuteRate >= nestMinuteRate) {
    ctx.addIssue({
      code: 'custom',
      path: ['THROTTLE_STRICT_MINUTE_MAX'],
      message: `must permit a lower rate than the default per-minute limit (currently ${nestStrictMinuteRate.toFixed(3)}/s strict vs ${nestMinuteRate.toFixed(3)}/s default)`,
    });
  }
});

export type Env = z.infer<typeof envSchema>;
