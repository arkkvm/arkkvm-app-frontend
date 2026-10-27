/**
 * @Purpose:
 * @Descripttion:
 * @version:
 * @Author: zhanglei
 * @Date: 2025-10-27 16:25:25
 * @LastEditors: zhanglei
 * @LastEditTime: 2026-05-28 11:48:20
 */
import { createLogger } from '@/utils/logger';
import { request } from '@/api';
import type { kvmIceConfigResponse } from '@/api/types';
import { IconCloud } from '@/assets/icons';
import { AspectRatioContainer } from '@/components';
import DeviceCard from '@/components/DeviceCard';
import { Dialog } from '@/components/Dialog';
import TopNavbar from '@/components/TopNavbar/TopNavbar';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import type { PageMeta } from '@/types/page-meta';
import { env } from '@/utils/env';
import { parseVersions } from '@/utils/parse';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useInterval } from 'usehooks-ts';

const logger = createLogger('DeviceList');

export const meta: PageMeta = {
  auth: true,
  title: 'devices-list',
  target: 'cloud',
};

interface DeviceListItem {
  id: string
  name: string
  online: boolean
  cloudVersion?: unknown
}

export default function DeviceList() {
  const { t } = useTranslation('common');
  const { confirm } = useConfirmDialog();
  const [deviceList, setDeviceList] = useState<DeviceListItem[]>(() => {
    try {
      const cached = sessionStorage.getItem('device_list_cache');
      return cached ? (JSON.parse(cached) as DeviceListItem[]) : [];
    } catch {
      return [];
    }
  });
  const [topbarShowLoggedIn] = useState(true);
  const [iceServers, setIceServers] = useState<RTCIceServer[] | null>(null);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameDeviceId, setRenameDeviceId] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [renameSubmitting, setRenameSubmitting] = useState(false);
  let [delay, setDelay] = useState(0);

  useEffect(() => {
    request.post<kvmIceConfigResponse>('/webrtc/ice_config', {}, {}).then(({ data: iceResp }) => {
      if (iceResp?.iceServers) {
        setIceServers(
          Array.isArray(iceResp.iceServers) ? iceResp.iceServers : [iceResp.iceServers]
        );
      }
    }).catch(() => {});
  }, []);

  const rtcConfig = useMemo(() => ({ iceServers: iceServers ?? [] }), [iceServers]);

  const fetchDeviceList = useCallback(async () => {
    try {
      const res = await request.get('/devices');
      if (res.success) {
        const data = Array.isArray(res.data)
          ? (res.data as DeviceListItem[])
          : [];
        setDeviceList(data);
        try { sessionStorage.setItem('device_list_cache', JSON.stringify(data)); } catch {}
      } else {
        logger.error('Failed to fetch devices', { code: res.code });
      }
    } catch (error) {
      logger.error('Failed to fetch devices:', error);
    }
  }, []);

  useInterval(() => {
    setDelay(delay + 1);
  }, 50000);

  useEffect(() => {
    void fetchDeviceList();
  }, [delay, fetchDeviceList]);

  const handleRenameDevice = useCallback(
    (deviceId: string, deviceName: string) => {
      setRenameDeviceId(deviceId);
      setRenameValue(typeof deviceName === 'string' ? deviceName : '');
      setRenameDialogOpen(true);
    },
    []
  );

  const submitRenameDevice = useCallback(async () => {
    const nextName = String(renameValue ?? '').trim();
    if (!renameDeviceId) return;

    if (!nextName) {
      toast.error(t('deviceCard.toast.renameRequired'));
      return;
    }

    try {
      setRenameSubmitting(true);
      const res = await request.put(`/devices/${renameDeviceId}`, {
        name: nextName,
      });
      if (res.success) {
        toast.success(
          t('deviceCard.toast.renameSuccess', { deviceName: nextName })
        );
        setRenameDialogOpen(false);
        setRenameDeviceId('');
        await fetchDeviceList();
        return;
      }
      toast.error(t('deviceCard.toast.renameFailed'));
    } catch {
      toast.error(t('deviceCard.toast.renameFailed'));
    } finally {
      setRenameSubmitting(false);
    }
  }, [fetchDeviceList, renameDeviceId, renameValue, t]);

  const handleUnbindDevice = useCallback(
    async (deviceId: string, deviceName: string) => {
      const displayName =
        String(deviceName ?? '').trim() || t('deviceCard.unknownName');
      const unbindText = t('deviceCard.confirm.unbind', {
        deviceName: displayName,
      });
      confirm({
        title: t('deviceCard.unbindDialog.title'),
        content: (
          <div className="flex flex-col gap-[12px] whitespace-pre-line">
            {unbindText.split(/\n\n+/).map((paragraph, idx) => (
              <p key={idx}>{paragraph}</p>
            ))}
          </div>
        ),
        confirmText: t('deviceCard.unbindDialog.confirm'),
        cancelText: t('deviceCard.unbindDialog.cancel'),
        onConfirm: async () => {
          try {
            const res = await request.delete(`/cloud/devices/${deviceId}`);
            if (res.success) {
              toast.success(
                t('deviceCard.toast.unbindSuccess', { deviceName: displayName })
              );
              await fetchDeviceList();
              return;
            }
            toast.error(t('deviceCard.toast.unbindFailed'));
          } catch {
            toast.error(t('deviceCard.toast.unbindFailed'));
          }
        },
      });
    },
    [confirm, fetchDeviceList, t]
  );

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Dialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        title={t('deviceCard.renameDialog.title')}
        description={t('deviceCard.renameDialog.description')}
        width="420px"
        footerSlot={<></>}
      >
        <div className="pb-[18px]">
          <Input
            value={renameValue ?? ''}
            onChange={e => setRenameValue(e.target.value)}
            placeholder={t('deviceCard.renameDialog.placeholder')}
            autoFocus
            size="lg"
            onKeyDownCapture={e => {
              e.stopPropagation();
              if (e.nativeEvent.isComposing || renameSubmitting) return;
              if (e.key === 'Enter' || e.key === 'NumpadEnter') {
                e.preventDefault();
                void submitRenameDevice();
              }
            }}
          />
          <div className="flex items-center justify-end gap-2 pt-[16px]">
            <Button
              variant="default"
              size="lg"
              disabled={renameSubmitting}
              onClick={() => setRenameDialogOpen(false)}
            >
              {t('deviceCard.renameDialog.cancel')}
            </Button>
            <Button
              variant="primary"
              size="lg"
              loading={renameSubmitting}
              onClick={() => void submitRenameDevice()}
            >
              {t('deviceCard.renameDialog.save')}
            </Button>
          </div>
        </div>
      </Dialog>

      <TopNavbar
        links={[
          { title: 'Cloud Devices', href: '/devices/list', Icon: IconCloud },
        ]}
        showLoggedIn={topbarShowLoggedIn}
      ></TopNavbar>
      <AspectRatioContainer
        disableAspectRatio
        className="flex flex-col flex-1 min-h-0 w-full"
      >
        <div className="max-w-[1440px] w-full h-[142px] text-center pt-[60px] mx-auto pb-[26px] border-b border-[var(--border-color)]">
          <div className="text-[24px] font-[700] leading-[1]">
            {t('deviceCard.page.title')}
          </div>
          <div className="text-[16px] font-[400] leading-[1] mt-[15px]">
            {t('deviceCard.page.description')}
          </div>
        </div>

        {deviceList && deviceList.length > 0 ? (
          <div className="w-full flex-1 min-h-0 overflow-y-auto pb-[30px]">
            <div className="max-w-[1440px] mx-auto flex flex-row mt-[24px] gap-[20px] flex-wrap pb-[50px]">
              {deviceList.map(({ name, id, online, cloudVersion }, i) => {
                // Parse version data and extract webVersion
                const webVersion =  parseVersions(cloudVersion);
                const token = localStorage.getItem('token');
                const previewServerUrl = online && token
                  ? `${env.signalingUrl}?id=${id}&token=${token}`
                  : undefined;

                return (
                  <DeviceCard
                    key={'device-card-' + i}
                    deviceId={id}
                    deviceName={name}
                    online={online}
                    cloudVersion={webVersion}
                    serverUrl={previewServerUrl}
                    rtcConfig={rtcConfig}
                    onRename={handleRenameDevice}
                    onUnbind={handleUnbindDevice}
                  />
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex-1 max-w-[1440px] mx-auto ">
            {t('deviceCard.page.noData')}
          </div>
        )}
      </AspectRatioContainer>
    </div>
  );
}
