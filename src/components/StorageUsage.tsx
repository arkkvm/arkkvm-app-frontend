import { cn } from '@/lib/utils';
import { formatBytes } from '@/utils/transfer';
import { Info } from 'lucide-react';
import React from 'react';

export type StorageContentType = 'images' | 'userFiles'

export interface StorageUsageProps extends React.HTMLAttributes<HTMLDivElement> {
  totalBytes: number
  usedBytes?: number
  freeBytes?: number
  systemBytes?: number
  logBytes?: number
  contentBytes?: number
  contentType: StorageContentType
  onOpenDetails: () => void
  loading?: boolean
  title?: React.ReactNode
  rightText?: (percent: number) => React.ReactNode
  usedText?: (usedBytes: number) => React.ReactNode
  freeText?: (freeBytes: number) => React.ReactNode
  precision?: number
  barContainerClassName?: string
  mountKey?: string | number
}

const normalizeBytes = (value: number | undefined) =>
  Math.max(0, Number.isFinite(value) ? value ?? 0 : 0);

export const StorageUsage: React.FC<StorageUsageProps> = ({
  totalBytes, usedBytes, freeBytes, systemBytes, logBytes, contentBytes, contentType, onOpenDetails,
  loading = false, title = 'Available Storage', rightText, usedText, freeText,
  precision = 1, className, barContainerClassName, mountKey: _mountKey, ...rest
}) => {
  const total = normalizeBytes(totalBytes);
  const rawSystem = normalizeBytes(systemBytes);
  const rawLogs = normalizeBytes(logBytes);
  const rawContent = normalizeBytes(contentBytes);
  const knownUsed = Math.min(total, rawSystem + rawLogs + rawContent);
  const used = Math.min(total, usedBytes == null ? knownUsed : normalizeBytes(usedBytes));
  const system = Math.min(rawSystem, used);
  const logs = Math.min(rawLogs, Math.max(used - system, 0));
  const content = Math.min(rawContent, Math.max(used - system - logs, 0));
  const usedPercent = total ? Number(((used / total) * 100).toFixed(precision)) : 0;
  const free = freeBytes == null ? Math.max(total - used, 0) : Math.min(total, normalizeBytes(freeBytes));
  const width = (bytes: number) => total > 0 ? `${Math.min((bytes / total) * 100, 100)}%` : '0%';
  const renderPercentText = rightText ?? ((percent: number) => <>{percent}% used</>);
  const renderUsedText = usedText ?? ((bytes: number) => <>{formatBytes(bytes)} used</>);
  const renderFreeText = freeText ?? ((bytes: number) => <>{formatBytes(bytes)} free</>);
  const rowClassName = 'flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm';

  if (loading) {
    return <div className={cn('space-y-2', className)} {...rest}>
      <div className={rowClassName}><div>{title}</div><div className="h-3 w-12 animate-pulse rounded bg-gray-300" /></div>
      <div className={cn('h-2 rounded bg-white/10', barContainerClassName)}><div className="h-full w-1/3 animate-pulse rounded bg-gray-300" /></div>
      <div className={rowClassName}><div className="h-3 w-16 animate-pulse rounded bg-gray-300" /><div className="h-3 w-16 animate-pulse rounded bg-gray-300" /></div>
    </div>;
  }

  return <div className={cn('space-y-2', className)} {...rest}>
    <div className={rowClassName}><div className="min-w-0">{title}</div><div className="min-w-0 text-right">{renderPercentText(usedPercent)}</div></div>
    <div className={cn('flex h-2 overflow-hidden rounded bg-white/10', barContainerClassName)}>
      <div className="h-full min-w-1 shrink-0 bg-slate-400" style={{ width: width(system) }} />
      {logs > 0 && <div className="h-full shrink-0 bg-amber-500" style={{ width: width(logs) }} />}
      {content > 0 && <div data-storage-content={contentType} className="h-full shrink-0 bg-primary" style={{ width: width(content) }} />}
    </div>
    <div className={rowClassName}>
      <button
        type="button"
        onClick={event => {
          event.currentTarget.blur();
          onOpenDetails();
        }}
        className="flex min-w-0 items-center gap-1 rounded-sm text-left text-primary underline-offset-2 transition-colors hover:text-primary/80 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {renderUsedText(used)}<Info className="size-3.5 shrink-0" aria-hidden="true" />
      </button>
      <div className="min-w-0 text-right">{renderFreeText(free)}</div>
    </div>
  </div>;
};

export default StorageUsage;
