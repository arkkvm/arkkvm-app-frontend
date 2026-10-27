import { formatBytes } from '@/utils/transfer';
import { Dialog } from './Dialog';
import { Button } from './ui/button';

export interface StorageDetailRow {
  label: string;
  bytes?: number;
  required?: boolean;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}

const blurActiveElement = () => {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
};

interface StorageDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  typeLabel: string;
  usedLabel: string;
  requiredLabel: string;
  rows: StorageDetailRow[];
  note: string;
  closeLabel: string;
}

export function StorageDetailsDialog({
  open,
  onOpenChange,
  title,
  typeLabel,
  usedLabel,
  requiredLabel,
  rows,
  note,
  closeLabel,
}: StorageDetailsDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description=""
      showCancel={false}
      confirmText={closeLabel}
      onConfirm={() => {
        blurActiveElement();
        onOpenChange(false);
      }}
      width="min(720px, calc(100vw - 24px))"
      contentClassName="z-[301]"
      overlayClassName="z-[300]"
    >
      <div className="mt-2 text-sm">
        <div className="grid grid-cols-[minmax(0,1fr)_7rem_7rem] gap-3 border-b border-[var(--border-color)] bg-[var(--btn-outline-bg)] px-2 py-2 font-[400]">
          <span>{typeLabel}</span>
          <span>{usedLabel}</span>
          <span />
        </div>
        {rows.map(row => (
          <div
            key={row.label}
            className="grid grid-cols-[minmax(0,1fr)_7rem_7rem] items-center gap-3 border-b border-[var(--border-color)] px-2 py-2"
          >
            <span>{row.label}</span>
            <span className="tabular-nums">
              {row.bytes == null ? '--' : formatBytes(row.bytes)}
            </span>
            <span className="text-right">
              {row.required ? (
                requiredLabel
              ) : row.actionLabel ? (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={event => {
                    event.currentTarget.blur();
                    row.onAction?.();
                  }}
                  disabled={row.actionDisabled}
                >
                  {row.actionLabel}
                </Button>
              ) : null}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs italic text-text-secondary">{note}</p>
    </Dialog>
  );
}

interface StorageDeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  cancelLabel: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
}

export function StorageDeleteConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  cancelLabel,
  confirmLabel,
  onConfirm,
}: StorageDeleteConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      cancelText={cancelLabel}
      confirmText={confirmLabel}
      preventAutoCloseOnConfirm
      preventOutsideClose
      onConfirm={onConfirm}
      onCancel={() => {
        blurActiveElement();
        onOpenChange(false);
      }}
      width="500px"
      style={{ maxWidth: 'calc(100vw - 32px)' }}
      contentClassName="z-[401]"
      overlayClassName="z-[400]"
    />
  );
}
