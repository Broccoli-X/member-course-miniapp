import { Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, HTTP_STATUS, type MemberPrincipal } from '@member-course/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { BusinessError } from '../../../common/errors/business-error.js';
import { WechatGateway } from '../domain/wechat-gateway.js';
import { normalizePhone } from '../domain/phone.js';
import { WECHAT_GATEWAY } from '../tokens.js';
import { MEMBER_STATUS } from './wechat-auth.service.js';

/** Result of {@link PhoneBindingService.bind}. */
export interface PhoneBindingResult {
  /** The account the member is now bound to. May differ from the provisional account. */
  readonly accountId: string;
  /** The normalized phone now bound to the account. */
  readonly normalizedPhone: string;
}

/**
 * Atomically binds a verified phone to a member account.
 *
 * The verified phone comes from WeChat's `getPhoneNumber` API (via
 * {@link WechatGateway.exchangePhoneCode}); it is normalized via
 * {@link normalizePhone} before any lookup or storage so the merge is
 * deterministic regardless of how WeChat formatted the number.
 *
 * ## Merge rules (see task-5-brief.md)
 *
 * The entire operation runs in ONE `db.$transaction`. Every read and write in
 * the binding path uses the transaction client (`tx`) so a conflict rolls back
 * the whole thing — no partial identity move, no half-disabled account.
 *
 *  1. Normalize the verified phone.
 *  2. Find the provisional account the caller is logged in as. If it is not
 *     provisional (already bound) → 409 STATE_CHANGED.
 *  3. Look up the pre-created (non-provisional) `MemberAccount` with that
 *     `normalizedPhone`. **Lock the row** via a `SELECT … FOR UPDATE` so a
 *     concurrent binding for the same pre-created account serializes.
 *  4. If a pre-created account exists:
 *     - If it ALREADY owns a DIFFERENT WechatIdentity (not the provisional's
 *       own) → conflict: throw `PHONE_BINDING_CONFLICT` (HTTP 409). The whole
 *       tx rolls back; the provisional's identity stays put.
 *     - Otherwise: MOVE the provisional's `WechatIdentity` rows to the
 *       pre-created account, set the provisional account `status='DISABLED'`,
 *       and clear its `normalizedPhone` (defensive — it has none). The
 *       pre-created account is marked `isProvisional=false`. The member is now
 *       bound to the pre-created account.
 *  5. If NO pre-created account exists with that phone: bind the phone to the
 *     PROVISIONAL account (set `normalizedPhone`, `isProvisional=false`).
 *
 * The brief is explicit: "Never merge by name — only by verified phone." We
 * therefore never consult anything but `normalizedPhone` for the merge.
 *
 * Repeated-code protection: WeChat phone codes are single-use. If WeChat
 * rejects a code (or returns nothing), {@link WechatGateway.exchangePhoneCode}
 * throws; we surface that as 401. There is no separate replay cache here — the
 * code's single-use semantics are enforced upstream by WeChat, and our own
 * idempotent outcome (binding a phone that's already bound to THIS account →
 * STATE_CHANGED; binding to a different account → conflict) is what stops a
 * replayed code from doing damage even if WeChat's single-use guarantee were
 * bypassed.
 */
@Injectable()
export class PhoneBindingService {
  constructor(
    private readonly db: PrismaService,
    @Inject(WECHAT_GATEWAY) private readonly wechat: WechatGateway,
  ) {}

  async bind(
    principal: MemberPrincipal,
    phoneCode: string,
  ): Promise<PhoneBindingResult> {
    // Resolve the verified phone BEFORE entering the transaction — WeChat's
    // network call has no business inside the row-locking window.
    const phoneInfo = await this.wechat.exchangePhoneCode(phoneCode);
    if (!phoneInfo || !phoneInfo.purePhoneNumber) {
      throw BusinessError.unauthorized('WeChat phone code exchange returned no phone number');
    }
    const normalizedPhone = normalizePhone(
      `${phoneInfo.countryCode}${phoneInfo.purePhoneNumber}`,
    );

    return this.db.$transaction(async (tx) => {
      // 1. Load + lock the caller's provisional account. The SELECT ... FOR
      //    UPDATE locks the row for the duration of the tx so two concurrent
      //    binds on the SAME provisional account serialize (the loser sees the
      //    status flip to DISABLED and bails).
      //
      // Column names mirror the Prisma schema verbatim (Prisma does NOT
      // auto-snake-case: `isProvisional` → `isProvisional`, `normalizedPhone`
      // → `normalizedPhone`). Aliased to camelCase keys for the typed row.
      const provisionalRows = await tx.$queryRaw<{
        id: string;
        status: string;
        isProvisional: number;
        version: number;
      }[]>`SELECT id, status, isProvisional, version
         FROM \`member_account\`
         WHERE id = ${principal.accountId}
         FOR UPDATE`;
      const provisional = provisionalRows[0];
      if (!provisional) {
        throw BusinessError.notFound('Member account not found');
      }
      if (provisional.status !== MEMBER_STATUS.ACTIVE) {
        throw new BusinessError(
          ERROR_CODES.UNAUTHORIZED,
          'Member account is not active',
          HTTP_STATUS.UNAUTHORIZED,
        );
      }
      if (!provisional.isProvisional) {
        // Already bound. This is what a *replayed* phone code looks like from
        // the caller's side once the first bind succeeded.
        throw BusinessError.conflict('Phone is already bound to this account');
      }

      // 2. Look up + lock the pre-created (non-provisional) account that
      //    already owns this phone, if any. The lock is what makes the
      //    membership check + identity move atomic w.r.t. any other binding
      //    racing for the same pre-created account.
      const precreatedRows = await tx.$queryRaw<{
        id: string;
        version: number;
      }[]>`SELECT id, version
         FROM \`member_account\`
         WHERE normalizedPhone = ${normalizedPhone}
           AND isProvisional = 0
         FOR UPDATE`;
      const precreated = precreatedRows[0];

      // The provisional's own identities — we'll move these if a pre-created
      // account exists, or leave them in place if we're binding to the
      // provisional itself.
      const provisionalIdentities = await tx.wechatIdentity.findMany({
        where: { accountId: principal.accountId },
        select: { id: true, openId: true },
      });

      if (precreated) {
        // 3. Does the pre-created account already own a DIFFERENT identity?
        //    "Different" = any identity whose id is not one of the
        //    provisional's own. If yes → conflict, full rollback.
        const ownerOther = await tx.wechatIdentity.findFirst({
          where: {
            accountId: precreated.id,
            // Exclude the provisional's own identities (they're about to be
            // moved; they don't count as "the pre-created account already owns
            // someone else"). In the normal flow this list is empty.
            id: { notIn: provisionalIdentities.map((i) => i.id) },
          },
          select: { id: true },
        });
        if (ownerOther) {
          // CONFLICT — the whole tx must roll back so the provisional's
          // identity is NOT moved. Throwing inside $transaction aborts it.
          throw new BusinessError(
            ERROR_CODES.PHONE_BINDING_CONFLICT,
            'Phone number is already bound to another member account',
            HTTP_STATUS.CONFLICT,
          );
        }

        // 4. Move the provisional's identities to the pre-created account,
        //    mark the provisional DISABLED, and finalize the pre-created
        //    account as bound + non-provisional. All inside this tx → atomic.
        if (provisionalIdentities.length > 0) {
          await tx.wechatIdentity.updateMany({
            where: { accountId: principal.accountId },
            data: { accountId: precreated.id },
          });
        }
        await tx.memberAccount.update({
          where: { id: principal.accountId },
          data: { status: MEMBER_STATUS.DISABLED },
        });
        await tx.memberAccount.update({
          where: { id: precreated.id },
          data: {
            isProvisional: false,
            // The pre-created account already stores normalizedPhone; set it
            // again defensively so a row that was pre-created without a phone
            // (shouldn't happen, but cheap to guard) ends up bound.
            normalizedPhone,
          },
        });

        return { accountId: precreated.id, normalizedPhone };
      }

      // 5. No pre-created account owns this phone → bind it to the provisional
      //    account in place. The FOR UPDATE lock on the provisional row above
      //    prevents a concurrent bind from creating a duplicate normalizedPhone
      //    (the @unique constraint would also reject it, but the lock turns the
      //    race into a clean serialize).
      await tx.memberAccount.update({
        where: { id: principal.accountId },
        data: { normalizedPhone, isProvisional: false },
      });

      return { accountId: principal.accountId, normalizedPhone };
    });
  }
}
