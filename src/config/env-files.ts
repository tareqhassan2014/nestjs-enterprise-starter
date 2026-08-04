/**
 * Which `.env` files `ConfigModule` layers, most specific first.
 *
 * `.env.test` is committed (it holds no secrets) so `pnpm test` runs on a fresh
 * clone with no manual environment setup. `.env.local` and `.env` are ignored
 * by git and hold real local values.
 *
 * This lives in the config layer because it is one of the few places allowed to
 * read `process.env` — NODE_ENV must be known before validation can start.
 */
export function envFilePaths(): string[] {
  const nodeEnv = process.env.NODE_ENV ?? 'development';

  return [`.env.${nodeEnv}.local`, `.env.${nodeEnv}`, '.env.local', '.env'];
}
