// @no-export
import { useTranslation } from 'react-i18next';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter,
} from '@/components/ui/alert-dialog';
import type { ControlAction, ControlPrompt } from './useControlLease';

interface Props {
  prompt: ControlPrompt | null;
  busy: boolean;
  error: 'failed' | 'stale' | null;
  onAction: (action: ControlAction) => void;
  onViewOnly: () => void;
}

export function ControlLeaseDialog({ prompt, busy, error, onAction, onViewOnly }: Props) {
  const { t } = useTranslation('common');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const requesting = prompt?.kind === 'request';
  return (
    <AlertDialog open={prompt !== null}>
      <AlertDialogContent
        className="w-full max-w-xl"
        onOpenAutoFocus={event => {
          event.preventDefault();
          titleRef.current?.focus({ preventScroll: true });
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
            {t(`controlLease.${requesting ? 'requestTitle' : 'activeTitle'}`)}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(`controlLease.${requesting ? 'requestDescription' : 'activeDescription'}`)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="text-destructive">{t(`controlLease.${error}`)}</p>}
        <AlertDialogFooter className="flex-wrap gap-3">
          <Button disabled={busy || (requesting && error === 'stale')}
            onClick={() => requesting ? onAction('denyControl') : onViewOnly()}>
            {t(`controlLease.${requesting ? 'keepControl' : 'viewOnly'}`)}
          </Button>
          {requesting && <Button disabled={busy} onClick={onViewOnly}>{t('controlLease.viewOnly')}</Button>}
          <Button variant="primary" disabled={busy || error === 'stale'} loading={busy}
            onClick={() => onAction(requesting ? 'grantControl' : 'takeOverControl')}>
            {t(`controlLease.${requesting ? 'handOver' : 'takeOver'}`)}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
