import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { RequestContext } from '@common/context/request-context';
import {
  REQUEST_ID_HEADER,
  isAcceptableRequestId,
  resolveRequestId,
} from '@common/context/request-id';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    /**
     * Resolution is deliberately order-independent with respect to pino-http's
     * `genReqId`, which resolves the same way. Whichever middleware runs first
     * establishes the ID; the other reuses it. That avoids depending on Nest's
     * cross-module middleware ordering, where an imported module's middleware
     * (LoggerModule's) registers ahead of the importing module's.
     */
    const existing = (req as Request & { id?: unknown }).id;

    const requestId = isAcceptableRequestId(existing)
      ? existing
      : resolveRequestId(req.headers[REQUEST_ID_HEADER]);

    (req as Request & { id?: unknown }).id = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    RequestContext.run({ requestId }, () => {
      next();
    });
  }
}
