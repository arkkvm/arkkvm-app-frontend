/**
 * @Purpose: Route authentication guard
 * @Descripttion:
 * @version: 1.1.0
 * @Author: zhanglei
 * @Date: 2025-07-17 14:04:41
 * @LastEditors: zhanglei
 * @LastEditTime: 2026-05-06 21:13:47
 */
import { Layout } from '@/components/Layout';
import { useUserStore } from '@/stores';
import { env } from '@/utils/env';
import { getSafeRedirectUrl, normalizeDeviceId } from '@/utils/security';
import { FC, ReactNode, useEffect } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';

// Whether the app is running in cloud mode
const isCloudMode = env.target;

// Full-page loading spinner while auth state is resolving
const LoadingSpinner = () => {
  return (
    <div className="flex items-center justify-center h-screen">
      <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"></div>
    </div>
  );
};

const RouteAuth: FC<{ children?: ReactNode }> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    userInfo,
    token,
    isLoggedIn,
    loading,
  } = useUserStore();

  // Resolve auth status and handle login-page redirection
  useEffect(() => {
    const determineAuthStatus = async () => {
      // Auth checks are only required in cloud mode
      if (!isCloudMode) return;

      // If already logged in on /login, redirect unless opening a device-specific
      // login flow or an MCP consent flow (client=mcp + req, migration/15 §3):
      // the consent card must render for a signed-in user too, otherwise the
      // local MCP tool's loopback callback never fires and its login times out.
      if (isLoggedIn && location.pathname === '/login') {
        const searchParams = new URLSearchParams(location.search);
        const deviceId = normalizeDeviceId(searchParams.get('deviceId'));
        const mcpConsent = searchParams.get('client') === 'mcp' && Boolean(searchParams.get('req'));
        // Keep current page when deviceId exists or an MCP consent flow is
        // starting; otherwise redirect to previous/default path
        if (!deviceId && !mcpConsent) {
          const previousPath = getSafeRedirectUrl(location.state?.from?.pathname) || '/devices/list';
          navigate(previousPath, { replace: true });
        }
      }
    };

    determineAuthStatus();
  }, [
    token,
    userInfo,
    isLoggedIn,
    location.pathname,
    location.search,
    navigate,
    loading,
    isCloudMode,
  ]);

  // Paths that require authentication
  const protectedPaths = ['/devices/list', '/v-default/devices/:id'];
  const isProtectedPath = protectedPaths.some(path => {
    if (path.includes(':')) {
      // Match dynamic route patterns, e.g. /devices/:id
      const regex = new RegExp('^' + path.replace(/:[^/]+/g, '[^/]+') + '$');
      return regex.test(location.pathname);
    }
    return location.pathname === path;
  });

  // Render directly for routes that do not require auth
  if (!isProtectedPath) {
    return <>{children || <Outlet />}</>;
  }

  // Device mode does not require cloud auth
  if (!isCloudMode) {
    return <Layout>{children || <Outlet />}</Layout>;
  }

  if (loading) {
    return <LoadingSpinner />;
  }
  // Redirect unauthenticated users to login
  if (!isLoggedIn) {
    if (env.target === 'cloud') {
      return <Navigate to="/login" state={{ from: location }} replace />;
    } else {
      return <Navigate to="/login" state={{ from: location }} replace />;
    }
  }
  return <Layout>{children || <Outlet />}</Layout>;
};

export default RouteAuth;
