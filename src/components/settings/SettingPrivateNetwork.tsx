import type {
  PrivateNetworkOverlay,
  PrivateNetworkState,
  PrivateNetworkTarget,
} from '@/api/rpc/privateNetwork';
import { detectSessionOverlay } from '@/api/rpc/privateNetwork';
import { useJsonRpc } from '@/hooks/useJsonRpc';
import { createLogger } from '@/utils/logger';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirmDialog } from '../ui/confirm-dialog';
import { Select } from '../ui/select';
import SettingBlock from './SettingBlock';

const logger = createLogger('SettingPrivateNetwork');

/** Poll while a switch waits for the new overlay to connect. */
const PENDING_POLL_MS = 5000;

interface SettingPrivateNetworkProps {
  /**
   * Reports whether the device supports the selector. Older firmware has no
   * `getPrivateNetwork`; the page then keeps the independent switches.
   */
  onActiveChange: (active: boolean) => void;
  /** Called with the new state after every fetch, so overlay panels can refresh. */
  onStateChange?: (state: PrivateNetworkState) => void;
  /** Called after a target was applied (e.g. to start the Tailscale login flow). */
  onSelected?: (target: PrivateNetworkTarget) => void;
}

const OVERLAY_LABEL: Record<PrivateNetworkOverlay, string> = {
  tailscale: 'Tailscale',
  netbird: 'NetBird',
};

/**
 * One-of selector for the private network overlay: none / Tailscale / NetBird.
 *
 * The firmware switches "make before break": the new overlay starts first and the
 * previous one only stops once the new one is connected. On top of that, this
 * component warns when the current session runs over the overlay that would be
 * turned off.
 */
export default function SettingPrivateNetwork({
  onActiveChange,
  onStateChange,
  onSelected,
}: SettingPrivateNetworkProps) {
  const { t } = useTranslation(['settings']);
  const [, isChannelReady, sendAsync] = useJsonRpc();
  const { confirm } = useConfirmDialog();
  const [state, setState] = useState<PrivateNetworkState | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchState = useCallback(async () => {
    const next = await sendAsync({ method: 'getPrivateNetwork' }, { resultOnly: true });
    if (!next) {
      // Method missing on older firmware (or device busy): fall back to the old switches.
      onActiveChange(false);
      return null;
    }
    setState(next);
    onActiveChange(true);
    onStateChange?.(next);
    return next;
  }, [sendAsync, onActiveChange, onStateChange]);

  useEffect(() => {
    if (!isChannelReady) return;
    void fetchState();
  }, [isChannelReady, fetchState]);

  useEffect(() => {
    if (!state?.pendingTarget) return;
    const id = window.setInterval(() => void fetchState(), PENDING_POLL_MS);
    return () => window.clearInterval(id);
  }, [state?.pendingTarget, fetchState]);

  const sessionOverlay = detectSessionOverlay(state, window.location.hostname);

  const confirmSwitch = useCallback(
    async (target: PrivateNetworkTarget): Promise<boolean> => {
      if (!sessionOverlay || sessionOverlay === target) return true;
      const current = OVERLAY_LABEL[sessionOverlay];
      if (target === 'none') {
        return confirm({
          type: 'warning',
          title: t('settings:accessibility.privateNetworkSelector.lockout.title'),
          content: t('settings:accessibility.privateNetworkSelector.lockout.disable', { current }),
          confirmText: t('settings:accessibility.privateNetworkSelector.lockout.confirm'),
        });
      }
      return confirm({
        type: 'info',
        title: t('settings:accessibility.privateNetworkSelector.lockout.title'),
        content: t('settings:accessibility.privateNetworkSelector.lockout.switch', {
          current,
          next: OVERLAY_LABEL[target],
        }),
        confirmText: t('settings:accessibility.privateNetworkSelector.lockout.continue'),
      });
    },
    [confirm, sessionOverlay, t]
  );

  const handleChange = useCallback(
    async (value: string) => {
      const target = value as PrivateNetworkTarget;
      if (!(await confirmSwitch(target))) return;
      setBusy(true);
      logger.info('Selecting private network', { target });
      const resp = await sendAsync(
        { method: 'setPrivateNetwork', params: { target } },
        { timeout: 30000, showUnhandledErrorToast: true }
      );
      await fetchState();
      setBusy(false);
      if (resp.success) onSelected?.(target);
    },
    [confirmSwitch, sendAsync, fetchState, onSelected]
  );

  if (!state) return null;

  const value = state.pendingTarget ?? state.selection;
  const options = [
    { value: 'none', label: t('settings:accessibility.privateNetworkSelector.options.none') },
    { value: 'tailscale', label: 'Tailscale', disabled: !state.tailscale.available },
    { value: 'netbird', label: 'NetBird', disabled: !state.netbird.available },
  ];
  if (value === 'both') {
    options.push({
      value: 'both',
      label: t('settings:accessibility.privateNetworkSelector.options.both'),
      disabled: true,
    });
  }
  const previous: PrivateNetworkOverlay | null = state.pendingTarget
    ? state.pendingTarget === 'tailscale'
      ? 'netbird'
      : 'tailscale'
    : null;

  return (
    <SettingBlock
      title={t('settings:accessibility.privateNetworkSelector.title')}
      content={t('settings:accessibility.privateNetworkSelector.desc')}
    >
      <SettingBlock.Right>
        <Select
          value={value}
          size="xs"
          onChange={v => void handleChange(v)}
          options={options}
          disabled={!isChannelReady || busy}
        />
      </SettingBlock.Right>
      {(state.pendingTarget || value === 'both' || sessionOverlay) && (
        <SettingBlock.Bottom className="flex flex-col gap-2">
          {state.pendingTarget && previous && (
            <p className="text-xs text-text-muted border-l-2 border-blue-500 pl-3">
              {t('settings:accessibility.privateNetworkSelector.pending', {
                next: OVERLAY_LABEL[state.pendingTarget],
                previous: OVERLAY_LABEL[previous],
              })}
            </p>
          )}
          {!state.pendingTarget && value === 'both' && (
            <p className="text-xs text-text-muted border-l-2 border-yellow-500 pl-3">
              {t('settings:accessibility.privateNetworkSelector.legacyBoth')}
            </p>
          )}
          {sessionOverlay && (
            <p className="text-xs text-text-muted">
              {t('settings:accessibility.privateNetworkSelector.sessionVia', {
                overlay: OVERLAY_LABEL[sessionOverlay],
              })}
            </p>
          )}
        </SettingBlock.Bottom>
      )}
    </SettingBlock>
  );
}
