import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  type BindPhoneResponse,
  type MemberLogoutResponse,
  type MemberPrincipal,
  type MemberRefreshResponse,
  type WechatLoginResponse,
} from '@member-course/contracts';
import { WechatAuthService } from '../../application/wechat-auth.service.js';
import { PhoneBindingService } from '../../application/phone-binding.service.js';
import { MiniAuthGuard } from './mini-auth.guard.js';
import {
  WechatLoginDto,
  WechatLoginResponseDto,
} from './dto/wechat-login.dto.js';
import {
  BindPhoneDto,
  BindPhoneResponseDto,
} from './dto/bind-phone.dto.js';
import {
  MiniRefreshDto,
  MiniRefreshResponseDto,
  MiniLogoutDto,
  MiniLogoutResponseDto,
} from './dto/mini-refresh.dto.js';

/**
 * Mini-program (member) authentication endpoints.
 *
 * Path prefix `mini/v1/auth` combines with the global `/api` prefix set in
 * `main.ts` to produce the public routes:
 *   - `POST /api/mini/v1/auth/wechat-login`
 *   - `POST /api/mini/v1/auth/bind-phone`
 *   - `POST /api/mini/v1/auth/refresh`
 *   - `POST /api/mini/v1/auth/logout`
 *
 * All four endpoints are reachable by provisional (unbound) accounts — only
 * `bind-phone` requires authentication (a mini access token), and that token
 * is intentionally minted with `provisional: true` before phone binding so
 * the member can reach this very endpoint to bind.
 */
@Controller('mini/v1/auth')
export class MiniAuthController {
  constructor(
    private readonly wechatAuth: WechatAuthService,
    private readonly phoneBinding: PhoneBindingService,
  ) {}

  @Post('wechat-login')
  @HttpCode(HttpStatus.OK)
  async wechatLogin(@Body() body: WechatLoginDto): Promise<WechatLoginResponseDto> {
    const result = await this.wechatAuth.login(body.code);
    const response: WechatLoginResponse = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      provisional: result.provisional,
      accountId: result.accountId,
    };
    return response;
  }

  @Post('bind-phone')
  @UseGuards(MiniAuthGuard)
  @HttpCode(HttpStatus.OK)
  async bindPhone(
    @Req() req: Request & { memberPrincipal?: MemberPrincipal },
    @Body() body: BindPhoneDto,
  ): Promise<BindPhoneResponseDto> {
    // MiniAuthGuard guarantees memberPrincipal is populated; the non-null
    // assertion is safe because a missing principal short-circuits to 401.
    const principal = req.memberPrincipal!;
    const result = await this.phoneBinding.bind(principal, body.phoneCode);
    const response: BindPhoneResponse = {
      accountId: result.accountId,
      normalizedPhone: result.normalizedPhone,
    };
    return response;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: MiniRefreshDto): Promise<MiniRefreshResponseDto> {
    const result = await this.wechatAuth.refresh(body.refreshToken);
    const response: MemberRefreshResponse = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      // Echo the account's provisionality so the mini-program can restore its
      // in-memory `bound` flag on cold launch (bound = !provisional).
      provisional: result.provisional,
    };
    return response;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Body() body: MiniLogoutDto): Promise<MiniLogoutResponseDto> {
    const result = await this.wechatAuth.logout(body.refreshToken);
    const response: MemberLogoutResponse = { revoked: result.revoked };
    return response;
  }
}
