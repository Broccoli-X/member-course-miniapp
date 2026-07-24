import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { BusinessError } from './business-error.js';

@Catch()
export class BusinessErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(BusinessErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest<{ headers: Record<string, string | string[] | undefined>; traceId?: string }>();
    const traceId = request.headers['x-trace-id'] as string ?? request.traceId ?? 'unknown';

    let code: string;
    let message: string;
    let httpStatus: number;
    let details: Record<string, unknown> | undefined;

    if (exception instanceof BusinessError) {
      code = exception.code;
      message = exception.message;
      httpStatus = exception.httpStatus;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      httpStatus = exception.getStatus();
      const res = exception.getResponse();
      message = typeof res === 'string' ? res : ((res as Record<string, unknown>).message as string) ?? 'HTTP error';
      code = this.mapHttpStatusToCode(httpStatus);
    } else {
      this.logger.error(`Unhandled exception [${traceId}]: ${exception}`, exception instanceof Error ? exception.stack : undefined);
      code = 'INTERNAL_ERROR';
      message = 'Internal server error';
      httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
    }

    response.status(httpStatus).json({
      code,
      message,
      traceId,
      ...(details ? { details } : {}),
    });
  }

  private mapHttpStatusToCode(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST: return 'VALIDATION_FAILED';
      case HttpStatus.UNAUTHORIZED: return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN: return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND: return 'RESOURCE_NOT_FOUND';
      case HttpStatus.CONFLICT: return 'STATE_CHANGED';
      default: return 'INTERNAL_ERROR';
    }
  }
}
