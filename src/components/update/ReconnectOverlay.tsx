/**
 * @Purpose: Reconnection prompt overlay after update completion
 * @Author: zhanglei
 * @Date: 2026-02-07
 */
import { Loading } from '@/components/ui/Loading';
import { useAppStore } from '@/stores';
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';

/** Reconnect countdown seconds */
const RECONNECT_DELAY_SECONDS = 15;

/**
 * Reconnection prompt overlay after update completion
 * Shows countdown, auto-reconnects device after 15 seconds
 * Reconnect logic triggered by parent component listening to isReconnectOverlayVisible state change
 */
export function ReconnectOverlay() {
  const { t } = useTranslation('settings');
  const [countdown, setCountdown] = useState(RECONNECT_DELAY_SECONDS);

  const isVisible = useAppStore(s => s.update.isReconnectOverlayVisible);
  const hideOverlay = useAppStore.getState().update.hideReconnectOverlay;

  // Countdown logic
  useEffect(() => {
    if (!isVisible) {
      setCountdown(RECONNECT_DELAY_SECONDS);
      return;
    }

    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isVisible]);

  // Close overlay when countdown ends (parent component listens to state change to trigger reconnect)
  useEffect(() => {
    if (isVisible && countdown === 0) {
      hideOverlay();
    }
  }, [isVisible, countdown, hideOverlay]);

  // Manual reconnect immediately
  const handleReconnectNow = useCallback(() => {
    hideOverlay();
  }, [hideOverlay]);

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            className="flex w-full max-w-lg flex-col items-center gap-6 p-8 text-center"
          >
            {/* Loading animation */}
            <div className="relative">
              <Loading type="spinner" size="xl" color="blue" />
            </div>

            {/* Title */}
            <h2 className="text-2xl font-semibold text-text">
              {t('updateDialog.reconnect.title', {
                defaultValue: 'Update Completed',
              })}
            </h2>

            {/* Description */}
            <p className="w-full text-base text-gray-300">
              {t('updateDialog.reconnect.desc', {
                defaultValue:
                  'Your device has been updated successfully. Reconnecting in {{seconds}} seconds...',
                seconds: countdown,
              })}
            </p>

            {/* Reconnect now button */}
            <Button
              onClick={handleReconnectNow}

            >
              {t('updateDialog.reconnect.reconnectNow', {
                defaultValue: 'Reconnect Now',
              })}
            </Button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
