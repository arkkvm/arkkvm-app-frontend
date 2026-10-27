// @no-export
import type { readDeviceBindingConflict } from '@/api/deviceBinding';
import { StatusPalette } from '@/ui/statusColors';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';

interface DeviceConnectionFailureProps {
  deviceId: string;
  message: string;
  conflict?: ReturnType<typeof readDeviceBindingConflict>;
  busy: boolean;
  onRetry: () => void;
}

/** Owns failure presentation and optional masked account details. */
export default function DeviceConnectionFailure({
  deviceId, message, conflict, busy, onRetry,
}: DeviceConnectionFailureProps) {
  const { t } = useTranslation('common');
  const provider = conflict && ['google', 'microsoft', 'apple', 'github', 'wechat'].includes(conflict.provider)
    ? t(`deviceConnect.providers.${conflict.provider}`) : '';
  const account = [conflict?.account, provider].filter(Boolean).join(' / ');
  const paragraphs = conflict
    ? t(account ? 'deviceConnect.boundAccountError' : 'deviceConnect.boundAccountUnknown', {
        account,
        returnObjects: true,
      })
    : [message];
  return (
    <section role="alert" className="mx-auto w-full max-w-3xl space-y-6 px-4 text-center sm:px-0">
      <TriangleAlert aria-hidden="true" className={`mx-auto size-10 ${StatusPalette.error}`} />
      <h1 className="text-4xl font-bold leading-tight text-text">{t('deviceConnect.failureTitle')}</h1>
      {(Array.isArray(paragraphs) ? paragraphs : [message]).map((paragraph, index) => (
        <p key={index} className="whitespace-pre-line wrap-anywhere text-lg leading-7 text-muted-foreground">
          {paragraph}
        </p>
      ))}
      <p className="wrap-anywhere text-lg leading-7 text-muted-foreground">
        {t('deviceConnect.failureSerial', { serial: deviceId })}
      </p>
      {!conflict && (
        <Button variant="ghost" className="text-base" onClick={onRetry} disabled={busy}>{t('deviceConnect.retry')}</Button>
      )}
    </section>
  );
}
