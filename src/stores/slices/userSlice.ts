/**
 * User authentication state management.
 * Manages user login state, user information, and route permissions.
 */

import { request } from '@/api';
import { env } from '@/utils';
import { createLogger } from '@/utils/logger';
import type { StateCreator } from 'zustand';
import type { RootState } from '../types';

const logger = createLogger('UserStore');

export interface UserInfo {
  id: string | number
  email: string | null
  displayName?: string | null
  provider?: string | null
  googleId: string | null
  picture?: string | null
  oidcToken?: string | null
  /** Provider identities (doc 14 §4, additive /me field). */
  identities?: Array<{
    provider: string
    email: string | null
    displayName?: string | null
    avatarUrl?: string | null
  }>
  [key: string]: unknown
}

export interface RouteAuth {
  [key: string]: boolean
}

export interface UserState {
  userInfo: UserInfo | null
  token: string | null
  isLoggedIn: boolean
  useRouteAuth: RouteAuth
  loading: boolean
}

export interface UserActions {
  setUserInfo: (userInfo: UserInfo | null) => void
  setToken: (token: string | null) => void
  setLoading: (loading: boolean) => void
  login: (token: string, userInfo: UserInfo) => void
  logout: (redirectTo?: string) => Promise<boolean>
  fetchUserDetail: () => Promise<UserInfo | null>
  getUserInfo: (forceRefresh?: boolean) => Promise<UserInfo | null>
  checkAuth: () => boolean
}

export type UserSlice = UserState & UserActions

const USER_DEFAULTS: UserState = {
  userInfo: null,
  token: localStorage.getItem('token'),
  isLoggedIn: !!localStorage.getItem('token'),
  useRouteAuth: {},
  loading: false,
};
export const createUserSlice: StateCreator<RootState, [], [], UserSlice> = (
  set,
  get
) => {
  let authGeneration = 0;
  let locallySignedOut = false;
  const bestEffort = (action: () => void) => {
    try { action(); } catch { logger.warn('Local logout cleanup step failed'); }
  };
  let logoutPending: Promise<boolean> | null = null;
  const clearLocalSession = () => {
    authGeneration++;
    locallySignedOut = true;
    set({ token: null, userInfo: null, isLoggedIn: false, loading: false, useRouteAuth: {} });
    bestEffort(() => get().rtc.resetRTC());
    bestEffort(() => get().clearUploads());
    set({ password: '', virtualMedia: { ...get().virtualMedia, customImages: [] } });
    bestEffort(() => localStorage.removeItem('token'));
    bestEffort(() => localStorage.removeItem('devices-storage'));
    bestEffort(() => sessionStorage.removeItem('csrfToken'));
    bestEffort(() => sessionStorage.removeItem('device_list_cache'));
  };
  // Same-origin tabs discard their in-memory sessions without issuing another logout.
  window.addEventListener('storage', event => {
    if (event.key !== 'arkkvm-logout' || !event.newValue) return;
    clearLocalSession();
    window.location.replace(env.target === 'cloud' ? '/login' : '/login-local');
  });
  return ({
  ...USER_DEFAULTS,

  setUserInfo: userInfo => set({ userInfo }),

  setToken: token => {
    if (token) {
      localStorage.setItem('token', token);
    } else {
      localStorage.removeItem('token');
    }
    set({ token, isLoggedIn: !!token });
  },

  setLoading: loading => set({ loading }),

  login: (token, userInfo) => {
    authGeneration++;
    locallySignedOut = false;
    logoutPending = null;
    localStorage.setItem('token', token);
    set({
      token,
      userInfo,
      isLoggedIn: true,
      loading: false,
    });
  },

  // The boolean reports server revocation only; local logout always completes.
  logout: (redirectTo?: string) => {
    if (logoutPending) return logoutPending;
    logoutPending = (async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let revoked = false;
      try {
        // Start with the current credentials before removing them locally.
        const remote = env.target === 'cloud'
          ? request.get('/logout', { signal: controller.signal })
          : request.post('/auth/logout', undefined, { signal: controller.signal });
        clearLocalSession();
        bestEffort(() => localStorage.setItem('arkkvm-logout', crypto.randomUUID()));
        const timeout = new Promise<null>(resolve => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(null);
          }, 5000);
        });
        revoked = (await Promise.race([remote, timeout]))?.success === true;
      } catch {
        revoked = false;
      } finally {
        clearTimeout(timer);
        controller.abort();
        // Also remove CSRF/cache data written by a response during logout.
        clearLocalSession();
        if (!revoked) bestEffort(() => sessionStorage.setItem('logout-revocation-failed', '1'));
        const loginPath = env.target === 'cloud' ? '/login' : '/login-local';
        const safeRedirect = redirectTo?.startsWith(`${loginPath}?`) ? redirectTo : loginPath;
        window.location.replace(safeRedirect);
      }
      return revoked;
    })();
    return logoutPending;
  },

  fetchUserDetail: async () => {
    if (locallySignedOut) return null;
    const generation = authGeneration;
    set({ loading: true });
    try {
      let userInfo = null;
      const res = await request.get<UserInfo>('/me');
      if (generation !== authGeneration) return null;
      if (res.success) {
        userInfo = res.data;
        set({ userInfo, loading: false });
      }
      return userInfo;
    } catch (error) {
      if (generation !== authGeneration) return null;
      logger.error('Failed to fetch user details:', error);
      set({ loading: false });
      return null;
    }
  },

  getUserInfo: async (forceRefresh = false) => {
    if (locallySignedOut) return null;
    const { userInfo: cachedUserInfo } = get();

    if (cachedUserInfo && !forceRefresh) {
      return cachedUserInfo;
    }

    const generation = authGeneration;
    set({ loading: true });
    try {
      const res = await request.get<UserInfo>('/me');
      if (generation !== authGeneration) return null;
      if (res.success && res.data) {
        const userInfo = res.data;
        set({
          userInfo,
          loading: false,
          isLoggedIn: true,
        });
        return userInfo;
      } else {
        set({
          userInfo: null,
          loading: false,
          isLoggedIn: false,
        });
        return null;
      }
    } catch (error) {
      if (generation !== authGeneration) return null;
      logger.error('Failed to get user info:', error);
      set({
        userInfo: null,
        loading: false,
        isLoggedIn: false,
      });
      return null;
    }
  },

  checkAuth: () => {
    const { token, userInfo } = get();
    return !!token && !!userInfo;
  },
});
};
