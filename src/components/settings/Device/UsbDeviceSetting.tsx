/**
 * @Author: zhanglei
 * @Date: 2025-10-27 16:25:25
 * @LastEditors: zhanglei
 * @LastEditTime: 2026-06-16 18:10:39
 */
/*
 * @Author: Lei Zhang daisy_zlei@163.com
 * @Date: 2025-10-27 16:25:25
 * @LastEditors: Lei Zhang daisy_zlei@163.com
 * @LastEditTime: 2026-06-08 11:47:32
 * @FilePath: /git-arkkvm-app-frontend/src/components/settings/UsbDeviceSetting.tsx
 * @Description:
 */
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import SettingBlock from '../SettingBlock';

export type UsbPresetOption = { value: string; label: string }

export interface UsbDeviceSettingProps {
  title: string
  content: string
  options: UsbPresetOption[]
  placeholder?: string
  value: string
  onChange: (val: string) => void
  onUpdate: () => void
  onRefresh: () => void
  devices?: unknown[]
  loading?: boolean
  saving?: boolean
  disabled?: boolean // e.g., channel not ready
  renderDevices?: (devices: unknown[]) => ReactNode // slot for rendering devices
  children?: ReactNode
  paddingBottom?: string | number
}

export default function UsbDeviceSetting({
  title,
  content,
  options,
  value,
  placeholder,
  onChange,
  onUpdate,
  onRefresh,
  devices,
  loading,
  saving,
  disabled,
  renderDevices,
  children,
  paddingBottom,
}: UsbDeviceSettingProps) {
  const { t } = useTranslation(['settings']);
  const renderDevicesNode = useMemo(
    () => (renderDevices ? renderDevices(devices || []) : null),
    [renderDevices, devices]
  );

  return (
    <SettingBlock
      title={title}
      content={content}
      titleSize={12}
      contentSize={10}
      paddingBottom={paddingBottom}
    >
      <SettingBlock.Right>
        <Select
          triggerClassName="w-[150px] text-[var(--text-color)]"
          size="xs"

          value={value}
          onChange={onChange}
          placeholder={placeholder}
          options={options || []}
          disabled={disabled}
        />
      </SettingBlock.Right>
      <SettingBlock.Bottom className="mt-[10px]">
        {value === 'custom' && (
          <>
            {children}
            {renderDevicesNode}
              <div className="flex gap-2 mt-[10px] ml-[20px]  pb-[16px]  justify-end">

              <Button size="xs" onClick={onRefresh} disabled={disabled || !!loading || saving} >
                {t('settings:common.refresh', 'Refresh')}
              </Button>
               <Button onClick={onUpdate}  variant="primary" size="xs" loading={saving} disabled={disabled || !!saving}>
              {t('settings:common.update', 'Apply Changes')}
              </Button>
            </div>
          </>
        )}
      </SettingBlock.Bottom>
    </SettingBlock>
  );
}
