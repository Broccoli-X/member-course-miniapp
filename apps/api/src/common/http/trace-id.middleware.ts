import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  use(req: Record<string, unknown>, res: { setHeader: (k: string, v: string) => void }, next: () => void): void {
    const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
    const traceId = (headers['x-trace-id'] as string) || randomUUID();
    req.traceId = traceId;
    res.setHeader('x-trace-id', traceId);
    next();
  }
}
