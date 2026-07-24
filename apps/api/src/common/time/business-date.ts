import { format, addDays } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

const SHANGHAI_TZ = 'Asia/Shanghai';

/**
 * Converts a UTC datetime to a Shanghai-local Date.
 */
function toShanghaiDate(utcDate: Date): Date {
  return toZonedTime(utcDate, SHANGHAI_TZ);
}

export function calculateExpiryDate(confirmedAt: Date, validDays: number): string {
  const shanghaiDate = toShanghaiDate(confirmedAt);
  const expiry = addDays(shanghaiDate, validDays);
  return format(expiry, 'yyyy-MM-dd');
}

export function toShanghaiDateString(utcDate: Date): string {
  return format(toShanghaiDate(utcDate), 'yyyy-MM-dd');
}

export function nowInShanghai(): string {
  return toShanghaiDateString(new Date());
}
