import { ERROR_CODES, HTTP_STATUS, type ErrorDetails } from '@member-course/contracts';

export class BusinessError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: ErrorDetails;

  constructor(
    code: string,
    message: string,
    httpStatus: number,
    details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
    this.httpStatus = httpStatus;
    if (details) this.details = details;
  }

  static validationFailed(message: string, details?: ErrorDetails): BusinessError {
    return new BusinessError(ERROR_CODES.VALIDATION_FAILED, message, HTTP_STATUS.BAD_REQUEST, details);
  }

  static notFound(message: string, details?: ErrorDetails): BusinessError {
    return new BusinessError(ERROR_CODES.RESOURCE_NOT_FOUND, message, HTTP_STATUS.NOT_FOUND, details);
  }

  static conflict(message: string, details?: ErrorDetails): BusinessError {
    return new BusinessError(ERROR_CODES.STATE_CHANGED, message, HTTP_STATUS.CONFLICT, details);
  }

  static unauthorized(message: string, details?: ErrorDetails): BusinessError {
    return new BusinessError(ERROR_CODES.UNAUTHORIZED, message, HTTP_STATUS.UNAUTHORIZED, details);
  }

  static forbidden(code: string, message: string, details?: ErrorDetails): BusinessError {
    return new BusinessError(code, message, HTTP_STATUS.FORBIDDEN, details);
  }

  static internal(message = 'Internal server error'): BusinessError {
    return new BusinessError(ERROR_CODES.INTERNAL_ERROR, message, HTTP_STATUS.INTERNAL_ERROR);
  }
}
