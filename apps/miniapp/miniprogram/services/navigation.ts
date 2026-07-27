/**
 * Navigation policy.
 *
 * Public pages (catalog + auth) are open to any visitor, bound or not, so a
 * prospective member can browse the catalog before binding a phone. Private
 * pages (students, my) require {@link sessionStore.isBound} — i.e. the member
 * has completed the verified-phone bind. An unbound visitor attempting a
 * private page is sent to login.
 *
 * The verbatim test case:
 *   sessionStore.setSession({bound:false, accessToken:'token'});
 *   canOpen('/pages/courses/index') === true;
 *   canOpen('/pages/students/index') === false;
 */

import { sessionStore } from '../stores/session-store';

/** Public routes reachable before phone binding. */
const PUBLIC_PAGES: ReadonlySet<string> = new Set<string>([
  'pages/courses/index',
  'pages/course-detail/index',
  'pages/login/index',
  'pages/bind-phone/index',
]);

/** Private routes requiring a bound (phone-verified) member. */
const PRIVATE_PAGES: ReadonlySet<string> = new Set<string>([
  'pages/students/index',
  'pages/student-edit/index',
  'pages/my/index',
]);

function normalizePath(raw: string): string {
  // Strip leading slash, query string, and hash; keep just the page path.
  let p = raw.startsWith('/') ? raw.slice(1) : raw;
  const qIndex = p.search(/[?#]/);
  if (qIndex >= 0) p = p.slice(0, qIndex);
  return p;
}

/** True iff `path` may be opened under the current session. */
export function canOpen(path: string): boolean {
  const p = normalizePath(path);
  if (PUBLIC_PAGES.has(p)) return true;
  if (PRIVATE_PAGES.has(p)) return sessionStore.isBound();
  // Unknown paths are conservatively blocked (open them explicitly when added).
  return false;
}

/**
 * Enforce the policy at navigation time. Callers pass the target url; if the
 * member isn't allowed in, they're routed to login instead.
 */
export function guardNavigateTo(url: string): void {
  if (canOpen(url)) {
    wx.navigateTo({ url });
  } else {
    wx.reLaunch({ url: '/pages/login/index' });
  }
}
