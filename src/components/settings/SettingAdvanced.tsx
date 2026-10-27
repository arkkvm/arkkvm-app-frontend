import { readForwardingSettings, writeForwardingSetting } from '@/services/deviceSettings';
import { Badge } from '../ui/badge';
import { type JsonRpcHandle } from '@/hooks/useJsonRpc';
import { useFileDownload } from '@/hooks/useFileDownload';
import { useLoadingMap } from '@/hooks/useLoading';
import { useAppStore } from '@/stores';
import {
  useActiveDeviceSettings,
  useSettingsActions,
  useSettingsStore,
} from '@/stores/devicesStore';
import { createLogger } from '@/utils/logger';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { useConfirmDialog } from '../ui/confirm-dialog';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';
import SettingBlock from './SettingBlock';
import SettingPageContainer from './SettingPageContainer';
import { getErrorReasonKey } from '@/utils/parse';
import { triggerLocalFileDownload } from '@/api/localFile';
import { env } from '@/utils/env';

const logger = createLogger('SettingAdvanced');

export default function SettingAdvanced({ rpc }: { rpc: JsonRpcHandle }) {
  const { t } = useTranslation(['settings', 'errors']);
  const [_send, isChannelReady, sendAsync] = rpc;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // State management
  const [, setDevChannel] = useState(false);
  const webTerminalEnabled = useActiveDeviceSettings(s => s.webTerminalEnabled);
  const [developerMode, setDeveloperMode] = useState(false);
  const [localLoopbackOnly, setLocalLoopbackOnly] = useState(false);
  const [sshKey, setSshKey] = useState('');
  useActiveDeviceSettings(s => s.debugMode);
  const [, setUsbEmulation] = useState(false);
  const setNestedDeviceSetting = useSettingsActions().setNestedDeviceSetting;
  const { isLoading, startLoading, stopLoading } = useLoadingMap([
    'resetConfig',
    'collectEvidence',
    'allLoading',
    'localLoopbackOnly',
  ]);
  const { confirm, info } = useConfirmDialog();
  const downloadStartTimeRef = useRef<number>(0);
  const networkDialogShownRef = useRef(false);
  const [facrotyResetState, setFacrotyResetState] = useState(false);
  const mcpEnabled = useActiveDeviceSettings(s => s.mcpEnabled) ?? false;
  const sshForwarding = useActiveDeviceSettings(s => s.sshForwarding) ?? false;
  const activeDeviceId = useSettingsStore(s => s.activeDeviceId);
  const [forwardingReady, setForwardingReady] = useState(false);
  const [forwardingBusy, setForwardingBusy] = useState(false);
  const [forwardingSaving, setForwardingSaving] = useState(false);
  const forwardingOperation = useRef(false);
  const forwardingGeneration = useRef(0);
  useEffect(() => {
    const generation = ++forwardingGeneration.current;
    setForwardingReady(false);
    setForwardingBusy(false);
    setForwardingSaving(false);
    forwardingOperation.current = false;
    if (!isChannelReady || !activeDeviceId) return;
    void readForwardingSettings(sendAsync).then(settings => {
      if (generation !== forwardingGeneration.current) return;
      if (!settings) {
        toast.error(t('settings:advanced.forwarding.unavailable'));
        return;
      }
      useSettingsStore
        .getState()
        .setDeviceSettingById(activeDeviceId, 'mcpEnabled', settings.mcpEnabled);
      useSettingsStore
        .getState()
        .setDeviceSettingById(activeDeviceId, 'sshForwarding', settings.sshForwarding);
      setForwardingReady(true);
    });
    return () => {
      ++forwardingGeneration.current;
    };
  }, [isChannelReady, activeDeviceId, sendAsync, t]);

  const handleForwardingChange = async (setting: 'mcp' | 'forwarding', enabled: boolean) => {
    if (!forwardingReady || !isChannelReady || forwardingOperation.current || !activeDeviceId)
      return;
    if (setting === 'forwarding' && !mcpEnabled) return;
    forwardingOperation.current = true;
    setForwardingBusy(true);
    const generation = forwardingGeneration.current;
    const current = () => generation === forwardingGeneration.current;
    const finish = () => {
      if (current()) {
        forwardingOperation.current = false;
        setForwardingBusy(false);
        setForwardingSaving(false);
      }
    };
    const apply = async () => {
      try {
        if (!current()) return;
        setForwardingSaving(setting === 'forwarding');
        const response = await writeForwardingSetting(sendAsync, setting, enabled);
        if (!current() || !response.success) return;
        // Read the authoritative state, including MCP's shutdown cascade.
        setForwardingReady(false);
        const settings = await readForwardingSettings(sendAsync);
        if (!current()) return;
        if (!settings) {
          toast.error(t('settings:advanced.forwarding.unavailable'));
          return;
        }
        useSettingsStore
          .getState()
          .setDeviceSettingById(activeDeviceId, 'mcpEnabled', settings.mcpEnabled);
        useSettingsStore
          .getState()
          .setDeviceSettingById(activeDeviceId, 'sshForwarding', settings.sshForwarding);
        setForwardingReady(true);
      } finally {
        finish();
      }
    };
    if (setting === 'forwarding' && enabled) {
      let confirmed = false;
      await confirm({
        title: t('settings:advanced.forwarding.confirmTitle'),
        content: (
          <div className="space-y-3 text-sm">
            {(
              t('settings:advanced.forwarding.confirmDescription', {
                returnObjects: true,
              }) as string[]
            ).map((line, index) => (
              <p key={index}>
                <Trans defaults={line} components={{ strong: <strong /> }} />
              </p>
            ))}
          </div>
        ),
        confirmText: t('settings:advanced.forwarding.enable'),
        cancelText: t('settings:advanced.forwarding.cancel'),
        onConfirm: () => {
          confirmed = true;
          return apply();
        },
      });
      // Radix also emits close after Enable. Only a real cancellation releases this lock here.
      if (!confirmed) finish();
      return;
    }
    await apply();
  };
  const peerConnectionState = useAppStore(s => s.rtc?.peerConnectionState ?? 'disconnected');
  const [downloadFile] = useFileDownload({
    requestDownload: async (task, sa) => {
      const res = await sa(
        { method: 'startLocalFileDownload', params: { path: task.path, offset: 0 } },
        { showUnhandledErrorToast: true, timeout: 120000 }
      );
      if (!res.result?.dataChannel) throw new Error('No dataChannel returned');
      return { dataChannel: res.result.dataChannel };
    },
    channelFilter: label => label.startsWith('local_download_'),
    onComplete: async task => {
      const elapsed = ((Date.now() - downloadStartTimeRef.current) / 1000).toFixed(2);
      logger.info(`[Diagnostic] Download complete in ${elapsed}s`, task);
      toast.success(`Diagnostic downloaded: ${task.name}`);
      const deleteRes = await sendAsync(
        { method: 'deleteCollectedEvidence', params: { path: task.path } },
        { showUnhandledErrorToast: true }
      );
      logger.info('deleteCollectedEvidence', deleteRes);
    },
    onError: task => {
      const elapsed = ((Date.now() - downloadStartTimeRef.current) / 1000).toFixed(2);
      logger.info(`[Diagnostic] Download failed after ${elapsed}s`, task);
      toast.error(`Download failed: ${task.errorMessage ?? 'Unknown error'}`);
    },
  });
  useEffect(() => {
    if (!isChannelReady) return;
    let isCancelled = false;
    void (async () => {
      startLoading('allLoading');
      const [
        devModeState,
        sshKeyState,
        usbEmulationState,
        devChannelState,
        localLoopbackOnlyState,
      ] = await Promise.all([
        sendAsync({ method: 'getDevModeState' }, { resultOnly: true }).catch(e => e),
        sendAsync({ method: 'getSSHKeyState' }, { resultOnly: true }).catch(e => e),
        sendAsync({ method: 'getUsbEmulationState' }, { resultOnly: true }).catch(e => e),
        sendAsync({ method: 'getDevChannelState' }, { resultOnly: true }).catch(e => e),
        sendAsync({ method: 'getLocalLoopbackOnly' }, { resultOnly: true }).catch(e => e),
      ]);
      logger.info('Settings loaded', {
        localLoopbackOnly: localLoopbackOnlyState,
      });
      stopLoading('allLoading');
      if (isCancelled) return;
      setDevChannel(!!devChannelState);
      setDeveloperMode(!!devModeState?.enabled);
      setLocalLoopbackOnly(!!localLoopbackOnlyState);
      setSshKey(sshKeyState || '');
      setUsbEmulation(!!usbEmulationState);
      setNestedDeviceSetting(prev => ({
        ...prev,
        developerMode: !!devModeState?.enabled,
      }));
    })();
    return () => {
      isCancelled = true;
    };
  }, [isChannelReady, sendAsync]);
  useEffect(() => {
    const isPeerDisconnected = ['disconnected', 'failed', 'closed'].includes(peerConnectionState);
    if (
      facrotyResetState &&
      (!isChannelReady || isPeerDisconnected) &&
      !networkDialogShownRef.current
    ) {
      stopLoading('resetConfig');
      networkDialogShownRef.current = true;
      info({
        title: t('settings:network.connectionLost.title', 'Connection Lost'),
        content: (
          <div className="space-y-1 text-sm">
            <p>
              {t(
                'settings:network.connectionLost.line1',
                'ArkKVM network settings have been applied.'
              )}
            </p>
            <p>
              {t(
                'settings:network.connectionLost.line2',
                'The IP address or VLAN configuration may have changed.'
              )}
            </p>
            <p>
              {t(
                'settings:network.connectionLost.line3',
                'Check the ArkKVM device screen for the current network information and reconnect.'
              )}
            </p>
          </div>
        ),
        type: 'error',
        confirmText: t('settings:network.connectionLost.ok', 'OK'),
      });
    }
  }, [isChannelReady, facrotyResetState, peerConnectionState]);

  const handleDeveloperModeChange = useCallback(
    async (checked: boolean) => {
      startLoading('developerMode');
      const { success } = await sendAsync({
        method: 'setDevModeState',
        params: { enabled: checked },
      });
      stopLoading('developerMode');
      if (success) {
        setNestedDeviceSetting(prev => ({
          ...prev,
          developerMode: checked,
        }));
        setDeveloperMode(checked);
      } else {
        toast.error(`Failed to ${checked ? 'enable' : 'disable'} Developer Mode`);
        // Rollback state
        setDeveloperMode(!checked);
      }
    },
    [sendAsync, setNestedDeviceSetting]
  );

  const handleLoopbackOnlyChange = useCallback(
    (checked: boolean) => {
      confirm({
        title: t('settings:advanced.loopbackOnly.confirm.title'),
        content: (
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 text-orange-600">⚠️</div>
              <div>
                <div className="font-medium text-orange-800 mb-2">
                  {t('settings:advanced.loopbackOnly.confirm.warning')}
                </div>
                <div className="text-sm">
                  {t('settings:advanced.loopbackOnly.confirm.prereqNote')}
                </div>
                <ul className="text-sm space-y-1 ml-4">
                  <li className="text-sm">
                    • {t('settings:advanced.loopbackOnly.confirm.prereqSsh')}
                  </li>
                  <li className="text-sm">
                    • {t('settings:advanced.loopbackOnly.confirm.prereqCloud')}
                  </li>
                </ul>
              </div>
            </div>
          </div>
        ),
        confirmText: t('settings:advanced.loopbackOnly.confirm.confirmText'),
        cancelText: t('settings:advanced.loopbackOnly.confirm.cancelText'),
        onConfirm: async () => {
          // setLocalLoopbackOnly(checked);
          //startLoading
          startLoading('localLoopbackOnly');
          const { success, result } = await sendAsync(
            {
              method: 'setLocalLoopbackOnly',
              params: { enabled: checked },
              successMessage: 'Loopback-only mode enabled. Restart your device to apply.',
            },
            { showUnhandledErrorToast: true }
          );
          stopLoading('localLoopbackOnly');
          if (!success) return;
          setLocalLoopbackOnly(result ?? false);
        },
      });
    },
    [sendAsync, startLoading, stopLoading, confirm, t]
  );

  const handleWebTerminalChange = useCallback(
    (checked: boolean) => {
      logger.info('Web Terminal changed', { enabled: checked });
      setNestedDeviceSetting(prev => ({
        ...prev,
        webTerminalEnabled: checked,
      }));
    },
    [setNestedDeviceSetting]
  );

  const handleUpdateSshKey = useCallback(async () => {
    const { success } = await sendAsync(
      { method: 'setSSHKeyState', params: { sshKey } },
      { showUnhandledErrorToast: true }
    );
    if (!success) return;
    toast.success(t('settings:advanced.sshAccess.successMessage'));
  }, [sendAsync, sshKey, t]);

  const handleResetConfig = useCallback(async () => {
    await confirm({
      title: t('settings:advanced.troubleshooting.resetConfig.confirm.title'),
      content: (
        <div className="space-y-2 text-sm">
          {(
            t('settings:advanced.troubleshooting.resetConfig.confirm.desc', {
              returnObjects: true,
            }) as string[]
          ).map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </div>
      ),
      confirmText: t('settings:advanced.troubleshooting.resetConfig.confirm.button'),
      cancelText: t('settings:advanced.troubleshooting.resetConfig.confirm.cancel', 'Cancel'),
      onConfirm: async () => {
        startLoading('resetConfig');
        networkDialogShownRef.current = false;
        setFacrotyResetState(true);

        const { success, error } = await sendAsync({
          method: 'facrotyReset',
        });

        if (success) {
          toast.success('Configuration reset to default successfully');
          useAppStore.getState().resetGlobalSettings();
          void useAppStore.persist.clearStorage();
          void useSettingsStore.persist.clearStorage();
          setTimeout(() => {
            stopLoading('resetConfig');
            window.location.reload();
          }, 30000);
        } else if (error) {
          stopLoading('resetConfig');
          const title = getErrorReasonKey(error.data, {
            segmentIndex: 0,
          });
          const reasonKey = getErrorReasonKey(error?.data, {
            segmentIndex: 1,
          });
          if (title && reasonKey) {
            const ns = `${title}.${reasonKey}` as const;
            info({
              title: t(`errors:${title}.title`),
              content: t(`errors:${ns}`),
              confirmText: t(`errors:${title}.confirm`),
            });
            return;
          }
        }
      },
    });
  }, [confirm, t, sendAsync, info]);

  const handleCollectEvidence = useCallback(async () => {
    downloadStartTimeRef.current = Date.now();
    startLoading('collectEvidence');
    const { success, result } = await sendAsync(
      { method: 'collectEvidence' },
      { showUnhandledErrorToast: true, timeout: 600000 }
    );
    stopLoading('collectEvidence');
    if (success && result) {
      if (env.target === 'cloud') {
        downloadFile([{ name: result, path: result }]);
      } else {
        triggerLocalFileDownload(result, result)
          .then(() => {
            sendAsync(
              { method: 'deleteCollectedEvidence', params: { path: result } },
              { showUnhandledErrorToast: true }
            );
          })
          .catch(err => {
            toast.error(`Download failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
          });
      }
    }
  }, [sendAsync, startLoading, stopLoading, downloadFile]);

  return (
    <SettingPageContainer
      title={t('settings:pages.advanced.title')}
      description={t('settings:pages.advanced.description')}
    >
      <div className="max-w-[840px]">
        {/* Dev Channel Updates */}

        {/* <SettingBlock
        title="Dev Channel Updates"
        content="Receive early updates from the development channel"
      >
        <SettingBlock.Right>
          <Switch checked={devChannel} onCheckedChange={toggleDevChannelUpdates} />
        </SettingBlock.Right>
      </SettingBlock> */}

        {/* Web Terminal */}
        <SettingBlock
          title={t('settings:advanced.webTerminal.title')}
          content={t('settings:advanced.webTerminal.desc')}
        >
          <SettingBlock.Right>
            <Switch checked={webTerminalEnabled} onCheckedChange={handleWebTerminalChange} />
          </SettingBlock.Right>
        </SettingBlock>

        {/* Loopback-Only Mode */}
        <SettingBlock
          title={t('settings:advanced.loopbackOnly.title')}
          content={t('settings:advanced.loopbackOnly.desc')}
        >
          <SettingBlock.Right>
            <Switch
              checked={localLoopbackOnly}
              onCheckedChange={handleLoopbackOnlyChange}
              disabled={isLoading('allLoading') || isLoading('localLoopbackOnly')}
            />
          </SettingBlock.Right>
        </SettingBlock>

        {/* SSH Access */}
        <SettingBlock
          title={t('settings:advanced.sshAccess.title')}
          content={t('settings:advanced.sshAccess.desc')}
        >
          <SettingBlock.Right>
            <Switch
              checked={developerMode}
              onCheckedChange={handleDeveloperModeChange}
              disabled={isLoading('allLoading') || isLoading('developerMode')}
            />
          </SettingBlock.Right>
          {developerMode && (
            <SettingBlock.Bottom className="pl-[24px]">
              <div className="space-y-3">
                <Textarea
                  ref={textareaRef}
                  value={sshKey}
                  label={t('settings:advanced.sshAccess.keyLabel')}
                  rows={3}
                  onChange={e => setSshKey(e.target.value)}
                  placeholder={t('settings:advanced.sshAccess.keyPlaceholder')}
                  className="font-mono text-sm!"
                  labelClassName="text-sm"
                />
                <div className="flex items-center justify-between">
                  <div className="text-sm text-gray-600 md:text-sm">
                    {t('settings:advanced.sshAccess.defaultUserText')}{' '}
                    <span className="font-mono bg-gray-100 px-1 rounded">root</span>.
                  </div>
                  <Button variant="primary" size="xs" onClick={handleUpdateSshKey}>
                    {t('settings:advanced.sshAccess.updateButton')}
                  </Button>
                </div>
              </div>
            </SettingBlock.Bottom>
          )}
        </SettingBlock>

        <SettingBlock
          title={t('settings:advanced.troubleshooting.resetConfig.title')}
          content={t('settings:advanced.troubleshooting.resetConfig.desc')}
        >
          <SettingBlock.Right>
            <Button
              variant="default"
              size="xs"
              status="danger"
              className="bg-(--btn-filled-bg-danger)"
              onClick={handleResetConfig}
              loading={isLoading('resetConfig')}
            >
              {t('settings:advanced.troubleshooting.resetConfig.button')}
            </Button>
          </SettingBlock.Right>
        </SettingBlock>

        {/* Diagnostic */}
        <SettingBlock
          title={t('settings:advanced.troubleshooting.diagnostic.title')}
          content={t('settings:advanced.troubleshooting.diagnostic.descSlow')}
        >
          <SettingBlock.Right>
            <Button
              variant="primary"
              size="xs"
              onClick={handleCollectEvidence}
              loading={isLoading('collectEvidence')}
            >
              {t('settings:advanced.troubleshooting.diagnostic.button')}
            </Button>
          </SettingBlock.Right>
        </SettingBlock>
        <SettingBlock
          title={
            <span className="inline-flex items-center gap-2">
              {t('settings:advanced.mcp.title')}
              <Badge>{t('settings:advanced.mcp.experimental')}</Badge>
            </span>
          }
          content={t('settings:advanced.mcp.desc')}
        >
          <SettingBlock.Right>
            <Switch
              aria-label={t('settings:advanced.mcp.title')}
              checked={mcpEnabled}
              onCheckedChange={enabled => void handleForwardingChange('mcp', enabled)}
              disabled={!isChannelReady || !forwardingReady || forwardingBusy}
            />
          </SettingBlock.Right>
        </SettingBlock>
        <SettingBlock
          title={t('settings:advanced.forwarding.title')}
          content={t('settings:advanced.forwarding.desc')}
          className="pl-[24px]"
        >
          <SettingBlock.Right className="flex items-center gap-2">
            {forwardingSaving && (
              <span role="status" className="inline-flex items-center text-text">
                <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
                <span className="sr-only">{t('settings:advanced.forwarding.saving')}</span>
              </span>
            )}
            <Switch
              aria-label={t('settings:advanced.forwarding.title')}
              aria-busy={forwardingSaving}
              checked={sshForwarding}
              onCheckedChange={enabled => void handleForwardingChange('forwarding', enabled)}
              disabled={!isChannelReady || !forwardingReady || forwardingBusy || !mcpEnabled}
            />
          </SettingBlock.Right>
          <SettingBlock.Bottom className="pl-[24px]">
            <p className="text-sm text-warning">{t('settings:advanced.forwarding.warning')}</p>
          </SettingBlock.Bottom>
        </SettingBlock>
      </div>
    </SettingPageContainer>
  );
}
