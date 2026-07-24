import {
  type AdminLoginRequest,
  type AdminLoginResponse,
} from '@member-course/contracts';

/**
 * Plain DTO for `POST /api/admin/v1/auth/login`. Mirrors the
 * {@link AdminLoginRequest} contract; kept as a class for future class-validator
 * wiring. Validation is intentionally minimal (no global ValidationPipe is
 * registered — see `task-4-brief.md`).
 */
export class AdminLoginDto implements AdminLoginRequest {
  username!: string;
  password!: string;
}

export type AdminLoginResponseDto = AdminLoginResponse;
