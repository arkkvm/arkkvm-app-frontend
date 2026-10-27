/**
 * @Purpose: Application entry component
 * @Descripttion: Integrates i18n, theme settings and routing system
 * @version: 1.0.0
 * @Author: zhanglei
 * @Date: 2025-07-14 15:45:53
 * @LastEditors: zhanglei
 * @LastEditTime: 2026-02-07 02:51:01
 */

import { Suspense, useEffect } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

import { useAppStore } from '@/stores';

import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog';
import { Toaster } from '@/components/ui/sonner';
import RouterProvider from './router';

import '@/styles/components.css';
import './App.css';

const GlobalLoadingFallback = () => (
  <div className="loading-box">Loading...</div>
);
const App = () => {
  const { i18n, t } = useTranslation('common');
  useEffect(() => {
    if (sessionStorage.getItem('logout-revocation-failed') !== '1') return;
    sessionStorage.removeItem('logout-revocation-failed');
    toast.warning(t('login.logoutRevocationFailed'), { duration: Infinity });
  }, [t]);
  const currentLang = useAppStore(s => s.currentLang);
  const currentTheme = useAppStore(s => s.currentTheme);
  const setTheme = useAppStore(s => s.setTheme);
  useEffect(() => {
    i18n.changeLanguage(currentLang || 'en');
  }, [currentLang, i18n]);

  useEffect(() => {
    const storedTheme = localStorage.getItem('ui-theme');
    if (storedTheme && storedTheme !== currentTheme) {
      setTheme(storedTheme);
    }
  }, []);
  useEffect(() => {
    document.documentElement.classList.remove('dark', 'light');
    document.documentElement.classList.add(currentTheme);
  }, [currentTheme]);

  return (
    <Suspense fallback={<GlobalLoadingFallback />}>
      <ConfirmDialogProvider>
        <div className="h-full app-container">
          <RouterProvider />
          <Toaster
            position="top-center"
            richColors
            expand
            visibleToasts={9}
            closeButton
            duration={4000}
          />
        </div>
      </ConfirmDialogProvider>
    </Suspense>
  );
};

export default App;
