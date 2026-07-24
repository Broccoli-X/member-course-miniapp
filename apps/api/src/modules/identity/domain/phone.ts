/**
 * Phone-number normalization for member accounts.
 *
 * The schema stores `MemberAccount.normalizedPhone` as a `VarChar(20)` unique
 * column. To make lookups deterministic — and to make the "find the
 * pre-created account by phone" merge step reliable — every phone is normalized
 * to a single canonical form BEFORE it is stored or looked up. The canonical
 * form here is the digits of the country code followed by the digits of the
 * national number, e.g. `8613800000000`. This matches what the WeChat
 * `getPhoneNumber` API returns (`countryCode` `86` + `purePhoneNumber`
 * `13800000000`).
 *
 * We deliberately do NOT use `libphonenumber` here: it would pull in a large
 * metadata dependency for what is, in the mini-program context, an already
 * country-decorated input from WeChat. The rule is intentionally simple and
 * side-effect-free so it can be unit-tested exhaustively.
 */

/** Maximum length of a normalized phone (matches the `VarChar(20)` column). */
export const NORMALIZED_PHONE_MAX_LENGTH = 20;

/**
 * Normalize a phone number to its canonical digit-only form. The input may
 * contain spaces, dashes, parentheses, a leading `+`, etc. — all non-digits
 * are stripped. An empty result (no digits at all) is rejected so the column's
 * `NOT NULL`-equivalent invariant (a normalized phone is always a real number)
 * is preserved.
 *
 * @param input The raw phone number — typically `countryCode + purePhoneNumber`
 *   as returned by WeChat, but tolerant of human-typed forms for back-office
 *   tooling.
 * @throws {Error} when `input` contains no digits or exceeds
 *   {@link NORMALIZED_PHONE_MAX_LENGTH} digits.
 */
export function normalizePhone(input: string): string {
  const digits = input.replace(/\D+/g, '');
  if (digits.length === 0) {
    throw new Error(`Phone number has no digits: ${JSON.stringify(input)}`);
  }
  if (digits.length > NORMALIZED_PHONE_MAX_LENGTH) {
    throw new Error(
      `Phone number exceeds ${NORMALIZED_PHONE_MAX_LENGTH} digits: ${digits.length}`,
    );
  }
  return digits;
}
