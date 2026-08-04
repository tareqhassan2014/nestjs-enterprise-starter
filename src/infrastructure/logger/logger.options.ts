import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Params } from 'nestjs-pino';

import { RequestContext } from '@common/context/request-context';
import {
  REQUEST_ID_HEADER,
  resolveRequestId,
} from '@common/context/request-id';
import { isHealthPath, requestPath } from '@common/http/health-routes';
import type { LoggerConfig } from '@config/logger.config';

/**
 * Redaction is configured centrally and is not optional — call sites are not
 * trusted to remember. `fast-redact` (pino's engine) has no unbounded-depth
 * wildcard, so the sensitive key names are enumerated to three levels, which
 * covers realistic log payloads. Add a level here rather than redacting
 * ad hoc at a call site.
 */
const SENSITIVE_KEYS = ['password', 'token', 'secret', 'apiKey', 'accessToken'];

function redactionPaths(): string[] {
  const headerPaths = [
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
  ];

  const keyPaths = SENSITIVE_KEYS.flatMap((key) => [
    key,
    `*.${key}`,
    `*.*.${key}`,
  ]);

  return [...headerPaths, ...keyPaths];
}

/**
 * `pino-pretty` is a devDependency and is absent from the production image. If
 * NODE_ENV is ever misconfigured there, pino throws "unable to determine
 * transport target" during bootstrap and the container crash-loops. Degrading
 * to JSON is strictly better than failing to start over log formatting.
 */
function prettyTransportAvailable(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export function buildLoggerParams(config: LoggerConfig): Params {
  const usePretty = config.pretty && prettyTransportAvailable();

  return {
    /**
     * Express 5's path-to-regexp rejects a bare `*`. nestjs-pino defaults to it
     * and Nest auto-converts with a deprecation warning on every boot; naming
     * the wildcard keeps startup output clean.
     */
    forRoutes: ['{*splat}'],

    pinoHttp: {
      level: config.level,

      transport: usePretty
        ? {
            target: 'pino-pretty',
            options: {
              singleLine: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          }
        : undefined,

      redact: {
        paths: redactionPaths(),
        censor: '[redacted]',
      },

      /**
       * Resolves identically to RequestContextMiddleware, so whichever runs
       * first wins and the other reuses the value. See design.md decision 3.
       */
      genReqId: (req: IncomingMessage): string =>
        RequestContext.getRequestId() ??
        resolveRequestId(req.headers[REQUEST_ID_HEADER]),

      /**
       * `mixin` covers application logs; `customProps` covers the automatic
       * request-completion log, which is emitted from a `finish` listener that
       * may sit outside the request's AsyncLocalStorage scope.
       */
      mixin: (): Record<string, string> => {
        const requestId = RequestContext.getRequestId();
        return requestId ? { requestId } : {};
      },

      customProps: (req: IncomingMessage): Record<string, string> => {
        const id = (req as IncomingMessage & { id?: unknown }).id;
        return typeof id === 'string' ? { requestId: id } : {};
      },

      // Probe traffic would otherwise dominate log volume.
      autoLogging: {
        ignore: (req: IncomingMessage): boolean =>
          isHealthPath(requestPath(req)),
      },

      customSuccessMessage: (
        _req: IncomingMessage,
        res: ServerResponse,
        responseTime: number,
      ): string => `request completed ${res.statusCode} in ${responseTime}ms`,
    },
  };
}
