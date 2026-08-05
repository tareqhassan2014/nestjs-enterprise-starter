import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

import { isHealthPath, requestPath } from '@common/http/health-routes';
import { isMcpPath } from '@common/http/mcp-routes';
import { isMetricsPath } from '@common/http/metrics-routes';

import { MetricsService } from './metrics.service';

/**
 * Records HTTP request metrics using the Nest route path template when
 * available (e.g. `/api/v1/admin/users/:userId/credits`), never raw URLs.
 */
@Injectable()
export class MetricsHttpInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const path = requestPath(request);

    if (isHealthPath(path) || isMetricsPath(path) || isMcpPath(path)) {
      return next.handle();
    }

    const started = process.hrtime.bigint();
    const method = request.method;
    const route = resolveRouteTemplate(context, request);

    return next.handle().pipe(
      tap({
        next: () => this.observe(method, route, response.statusCode, started),
        error: () => {
          const status = response.statusCode >= 400 ? response.statusCode : 500;
          this.observe(method, route, status, started);
        },
      }),
    );
  }

  private observe(
    method: string,
    route: string,
    status: number,
    started: bigint,
  ): void {
    const durationSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    this.metrics.recordHttpRequest({
      method,
      route,
      status,
      durationSeconds,
    });
  }
}

function resolveRouteTemplate(
  context: ExecutionContext,
  request: Request,
): string {
  const nestPath = (
    request as Request & { route?: { path?: string } }
  ).route?.path;
  if (typeof nestPath === 'string' && nestPath.length > 0) {
    const globalPrefix = 'api';
    // Nest route.path is relative to the controller; prefer originalUrl stripped of query + ids is hard —
    // use Express layer path when present.
    return nestPath.startsWith('/') ? nestPath : `/${globalPrefix}/${nestPath}`;
  }

  const handler = context.getHandler()?.name ?? 'unknown';
  const controller = context.getClass()?.name ?? 'UnknownController';
  return `${controller}.${handler}`;
}
