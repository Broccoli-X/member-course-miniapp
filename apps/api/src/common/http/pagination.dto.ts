import { BusinessError } from '../errors/business-error.js';

export interface PaginationValues {
  page: number;
  pageSize: number;
  sort?: string;
}

export class PaginationDto {
  page: number = 1;
  pageSize: number = 20;
  sort?: string;
}

export function validatePagination(params: PaginationValues): PaginationDto {
  const dto = new PaginationDto();
  // Parse page without the `|| 1` coercion so that `page=0` is not silently
  // turned into 1 and the `< 1` check below can correctly reject it. A
  // missing/NaN page falls back to the default of 1.
  const parsedPage = Number(params.page);
  dto.page = Number.isNaN(parsedPage) ? 1 : parsedPage;
  // For pageSize, the default of 20 applies only when the value is missing or
  // not a number. An explicit out-of-range value (0, 101, ...) must NOT be
  // coerced to the default and must be rejected by the range check below.
  const parsedPageSize = Number(params.pageSize);
  dto.pageSize = Number.isNaN(parsedPageSize) ? 20 : parsedPageSize;
  dto.sort = params.sort;

  if (dto.page < 1) {
    throw BusinessError.validationFailed('page must be >= 1', { field: 'page' });
  }
  if (dto.pageSize < 1 || dto.pageSize > 100) {
    throw BusinessError.validationFailed('pageSize must be between 1 and 100', { field: 'pageSize' });
  }

  return dto;
}
