/**
 * Vue Router with an admin auth guard.
 *
 * Routes:
 *   - /login                      public
 *   - /  (AdminLayout shell)      protected
 *       - /members                member list
 *       - /members/:id            member detail
 *       - /courses                course list
 *       - /courses/create         create course
 *       - /courses/:id            edit course
 *
 * The navigation guard redirects any unauthenticated request for a protected
 * route to /login (preserving the intended destination in `query.redirect`).
 */
import {
  createRouter,
  createWebHistory,
  type Router,
  type RouterHistory,
  type RouteRecordRaw,
  type NavigationGuardWithThis,
} from 'vue-router';
import AdminLayout from '../layouts/AdminLayout.vue';
import LoginView from '../features/auth/LoginView.vue';
import MemberListView from '../features/members/MemberListView.vue';
import MemberDetailView from '../features/members/MemberDetailView.vue';
import CourseListView from '../features/catalog/CourseListView.vue';
import CourseEditView from '../features/catalog/CourseEditView.vue';
// Import the store factory (calling it lazily inside the guard) — referencing the
// function at module load is safe; only *calling* it before Pinia is active
// throws. Keeping a synchronous import avoids an async gap in the navigation
// guard that would otherwise leave `router.isReady()` resolved before the
// redirect settles.
import { useAuthStore } from '../stores/auth';

export const LOGIN_ROUTE = 'login';

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: LOGIN_ROUTE,
    component: LoginView,
    meta: { public: true },
  },
  {
    path: '/',
    component: AdminLayout,
    children: [
      { path: '', redirect: { name: 'members' } },
      {
        path: 'members',
        name: 'members',
        component: MemberListView,
      },
      {
        path: 'members/:id',
        name: 'member-detail',
        component: MemberDetailView,
        props: true,
      },
      {
        path: 'courses',
        name: 'courses',
        component: CourseListView,
      },
      {
        path: 'courses/create',
        name: 'course-create',
        component: CourseEditView,
      },
      {
        path: 'courses/:id',
        name: 'course-edit',
        component: CourseEditView,
        props: true,
      },
    ],
  },
];

/**
 * Auth guard: redirect unauthenticated users away from protected routes.
 * `useAuthStore` is imported eagerly (only its invocation needs Pinia active,
 * which is guaranteed by the time a navigation runs). Keeping the guard free of
 * `await` avoids an async gap that would let `router.isReady()` resolve before
 * a logout/login redirect settles.
 */
const authGuard: NavigationGuardWithThis<undefined> = (to) => {
  const auth = useAuthStore();

  if (to.meta.public) {
    if (to.name === LOGIN_ROUTE && auth.isAuthenticated) {
      return { name: 'members' };
    }
    return true;
  }

  if (!auth.isAuthenticated) {
    return { name: LOGIN_ROUTE, query: { redirect: to.fullPath } };
  }

  return true;
};

/**
 * Router factory. Production uses browser history; tests pass
 * `createMemoryHistory()` so the guard can be exercised without a real URL.
 */
export function createAdminRouter(history: RouterHistory = createWebHistory()): Router {
  const router = createRouter({ history, routes });
  router.beforeEach(authGuard);
  return router;
}

export default createAdminRouter();
