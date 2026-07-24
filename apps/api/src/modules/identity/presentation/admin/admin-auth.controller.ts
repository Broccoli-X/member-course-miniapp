import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  AdminLoginResponse,
  AdminLogoutResponse,
  AdminRefreshResponse,
} from '@member-course/contracts';
import { AdminAuthService } from '../../application/admin-auth.service.js';
import {
  AdminLoginDto,
  AdminLoginResponseDto,
} from './dto/admin-login.dto.js';
import {
  AdminRefreshDto,
  AdminRefreshResponseDto,
} from './dto/admin-refresh.dto.js';
import {
  AdminLogoutDto,
  AdminLogoutResponseDto,
} from './dto/admin-logout.dto.js';

/**
 * Administrator authentication endpoints.
 *
 * Path prefix `admin/v1/auth` is combined with the global `/api` prefix set in
 * `main.ts` to produce the public routes
 *   - `POST /api/admin/v1/auth/login`
 *   - `POST /api/admin/v1/auth/refresh`
 *   - `POST /api/admin/v1/auth/logout`
 */
@Controller('admin/v1/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: AdminLoginDto): Promise<AdminLoginResponseDto> {
    const result = await this.auth.login({
      username: body.username,
      password: body.password,
    });
    const response: AdminLoginResponse = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      admin: result.admin,
    };
    return response;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: AdminRefreshDto): Promise<AdminRefreshResponseDto> {
    const result = await this.auth.refresh(body.refreshToken);
    const response: AdminRefreshResponse = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
    };
    return response;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Body() body: AdminLogoutDto): Promise<AdminLogoutResponseDto> {
    const result = await this.auth.logout(body.refreshToken);
    const response: AdminLogoutResponse = { revoked: result.revoked };
    return response;
  }
}
