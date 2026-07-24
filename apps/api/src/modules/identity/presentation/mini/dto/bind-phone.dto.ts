import {
  type BindPhoneRequest,
  type BindPhoneResponse,
} from '@member-course/contracts';

/** DTO for `POST /api/mini/v1/auth/bind-phone`. */
export class BindPhoneDto implements BindPhoneRequest {
  phoneCode!: string;
}

export type BindPhoneResponseDto = BindPhoneResponse;
