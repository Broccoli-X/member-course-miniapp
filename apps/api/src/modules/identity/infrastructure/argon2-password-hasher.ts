import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PasswordHasher } from '../domain/password-hasher.js';

/**
 * Argon2id implementation of {@link PasswordHasher}. Uses argon2's defaults
 * (memory=64 MiB, time=3, parallelism=4) which target ~250ms per hash on
 * commodity hardware — strong enough for an admin console, fast enough for
 * unit tests that do real hashing in-process.
 */
@Injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  async verify(encoded: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(encoded, plain);
    } catch {
      // Malformed encoded hash → treat as no-match rather than throwing; the
      // service layer treats a failed verify as a failed login.
      return false;
    }
  }
}
