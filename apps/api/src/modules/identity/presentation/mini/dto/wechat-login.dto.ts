import {
  type WechatLoginRequest,
  type WechatLoginResponse,
} from '@member-course/contracts';

/**
 * DTO for `POST /api/mini/v1/auth/wechat-login`. Mirrors the
 * {@link WechatLoginRequest} contract; kept as a class for future
 * class-validator wiring (no global ValidationPipe is registered today — see
 * task-4-brief.md).
 */
export class WechatLoginDto implements WechatLoginRequest {
  code!: string;
}

export type WechatLoginResponseDto = WechatLoginResponse;
