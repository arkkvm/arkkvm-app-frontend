import {
  IconFolder,
  IconMountBack,
  IconNoFile,
  IconNoFile1,
  IconUSB,
  IconUnion,
} from '@/assets/icons';
import { cn } from '@/lib/utils';
import React from 'react';
import { useTranslation } from 'react-i18next';
import StorageUsage from '../../StorageUsage';
import { StorageDeleteConfirmDialog, StorageDetailsDialog, type StorageDetailRow } from '../../StorageDetailsDialog';
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../../ui/breadcrumb';
import { Button } from '../../ui/button';
import DataTable from '../../ui/data-table';
import UploadDropZone from '../../Upload';
import ActionPanel from '../ActionPanel';
import { completedColumns } from './columns';
import type { UseVirtualUsbDriveReturn } from './useVirtualUsbDrive';
import { commandClass } from './utils';
import { env } from '@/utils';
import { formatBytes } from '@/utils/transfer';

type FileManagerViewProps = UseVirtualUsbDriveReturn;

export default function FileManagerView(props: FileManagerViewProps) {
  const { t } = useTranslation('common');
  const {
    uploads,
    downloads,
    fileTransferState,
    currentPath,
    showCompletedList,
    storageInfo,
    ftStorageDetails,
    selectedCompletedRowKeys,
    setSelectedCompletedRowKeys,
    isDownload,
    downloadDisabledReason,
    canDeleteSelected,
    hasFtcacheUploadingConflict,
    hasActiveTransfers,
    isLoading,
    setListType,
    handleCreateDir,
    handleCreateFile,
    handleMountWithFileImg,
    handleDelete,
    handleDeleteAllFiles,
    handleDownload,
    handleBreadcrumbClick,
    getCompletedList,
    startParamsFn,
    onStartUpload,
    onSuccessUpload,
    onProgressUpload,
    onResumeStart,
    setState,
    truncateBytes,
    logger,
    uploadDropZoneRef,
  } = props;
  const [storageDetailsOpen, setStorageDetailsOpen] = React.useState(false);
  const [deleteAllFilesOpen, setDeleteAllFilesOpen] = React.useState(false);
  const confirmDeleteAllFiles = React.useCallback(async () => {
    await handleDeleteAllFiles();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setDeleteAllFilesOpen(false);
    setStorageDetailsOpen(false);
  }, [handleDeleteAllFiles]);
  const breadcrumbNodes = React.useMemo(() => {
    const norm = (p: string) => p.replace(/\\+/g, '/');
    const clean = norm(currentPath || '/');
    const parts = clean.split('/').filter(Boolean);
    // Build full path items
    const items: { label: string; full: string; raw: string }[] = [];
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : `/${part}`;
      items.push({ label: truncateBytes(part, 10), full: acc, raw: part });
    }

    // Split into head (root), middle (hidden), tail (last two)
    const tailCount = 2;
    const middle = items.length > tailCount ? items.slice(0, -tailCount) : [];
    const tail = items.slice(-tailCount);

    return (
      <Breadcrumb>
        <BreadcrumbList>
          {/* Root */}
          <BreadcrumbItem>
            {items.length === 0 ? (
              <BreadcrumbPage>{t('toolbar.virtualUsbDrive.myFiles')}</BreadcrumbPage>
            ) : (
              <BreadcrumbLink
                href="#"
                data-path="/"
                onClick={_e => handleBreadcrumbClick?.('/')}
                className="cursor-pointer"
              >
                {t('toolbar.virtualUsbDrive.myFiles')}
              </BreadcrumbLink>
            )}
          </BreadcrumbItem>

          {/* Ellipsis for hidden middle segments */}
          {middle.length > 0 ? (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="relative group">
                <BreadcrumbEllipsis />
                {/* Hover dropdown listing middle segments */}
                <div className="absolute z-10 mt-2 hidden min-w-[160px] rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] p-2 shadow-md group-hover:block">
                  <ul className="text-sm">
                    {middle.map(m => (
                      <li
                        key={m.full}
                        className="px-2 py-1 rounded hover:bg-[var(--btn-outline-bg)] cursor-pointer"
                      >
                        <a
                          href="#"
                          data-path={m.full}
                          onClick={_e => handleBreadcrumbClick?.(m.full)}
                          title={m.raw}
                        >
                          {m.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              </BreadcrumbItem>
            </>
          ) : null}

          {/* Tail: last two segments */}
          {tail.map((it, idx) => (
            <React.Fragment key={it.full}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {idx === tail.length - 1 ? (
                  <BreadcrumbPage data-path={it.full} title={it.raw}>
                    {it.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink
                    href="#"
                    data-path={it.full}
                    onClick={_e => handleBreadcrumbClick?.(it.full)}
                    className="cursor-pointer"
                    title={it.raw}
                  >
                    {it.label}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </React.Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
    );
  }, [currentPath, truncateBytes, handleBreadcrumbClick]);

  const openClearFilesConfirm = () => setDeleteAllFilesOpen(true);
  const deleteAllFilesDisabled = hasActiveTransfers || isLoading('deleteAllFiles');
  const storageRows: StorageDetailRow[] = (ftStorageDetails?.categories ?? []).map(category => {
    const label = t(`toolbar.virtualUsbDrive.storageDetails.categories.${category.id}`, {
      defaultValue: category.label,
    });

    return {
      label,
      bytes: category.bytesUsed,
      required: !category.clearable,
      actionLabel: category.clearable
        ? t('toolbar.virtualUsbDrive.storageDetails.deleteAllCategory', { label })
        : undefined,
      onAction: category.clearable ? openClearFilesConfirm : undefined,
      actionDisabled: deleteAllFilesDisabled || category.bytesUsed === 0,
    };
  });

  return (
    <div className="w-full min-w-0 space-y-[10px]">
      <ActionPanel
        title={t('toolbar.virtualUsbDrive.title')}
        subtitle={
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 pt-[10px]">
            {breadcrumbNodes}
            {fileTransferState === 'Kvm' && (
              <Button
                size="sm"
                variant="default"
                className="btn-secondary"
                loading={isLoading('ftCreateDir')}
                disabled={isLoading('ftCreateDir')}
                onClick={handleCreateDir}
              >
                <IconFolder className="w-4 h-4 mr-1" />
                {t('toolbar.virtualUsbDrive.createDir')}
              </Button>
            )}
          </div>
        }
        className="min-w-0 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-4"
        rightSlot={
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            {fileTransferState === 'Kvm' &&
              (() => {
                const isRunning =
                  uploads?.some(u => u.state === 'running') ||
                  downloads?.some(d => d.state === 'running');
                const totalCount = (uploads?.length ?? 0) + (downloads?.length ?? 0);
                return (
                  <Button
                    size="sm"
                    variant="default"
                    className="relative"
                    onClick={() => setListType('transfer')}
                  >
                    <IconUnion
                      className={isRunning ? 'animate-pulse text-green-400' : 'text-gray-400'}
                    />
                    {totalCount > 0 ? (
                      <span
                        className={
                          'absolute -top-1.5 -right-1.5 flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full text-[10px] leading-none bg-gray-500 text-text'
                        }
                      >
                        {totalCount}
                      </span>
                    ) : null}
                  </Button>
                );
              })()}
            {['Kvm', 'None'].includes(fileTransferState) ? (
              <Button
                size="sm"
                loading={isLoading('mountWithFileImg')}
                disabled={isLoading('mountWithFileImg') || hasActiveTransfers}
                onClick={() => handleMountWithFileImg('RemoteUsb')}
                title={
                  hasActiveTransfers
                    ? t('toolbar.virtualUsbDrive.cannotMountWhileTransfer')
                    : undefined
                }
              >
                <IconUSB /> {t('toolbar.virtualUsbDrive.mountToRemote')}
              </Button>
            ) : null}
            {['RemoteUsb'].includes(fileTransferState) && (
              <Button
                size="sm"
                loading={isLoading('mountWithFileImg')}
                onClick={() => handleMountWithFileImg('Kvm')}
                disabled={isLoading('mountWithFileImg') || hasActiveTransfers}
                title={
                  hasActiveTransfers
                    ? t('toolbar.virtualUsbDrive.cannotMountWhileTransfer')
                    : undefined
                }
              >
                <IconMountBack /> {t('toolbar.virtualUsbDrive.mountToBack')}
              </Button>
            )}
          </div>
        }
        footer={
          <>
            {fileTransferState === 'Kvm' && (
              <>
                {downloadDisabledReason ? (
                  <div className="mr-auto text-sm text-[var(--text-muted)]">
                    {downloadDisabledReason}
                  </div>
                ) : (
                  <div className="mr-auto" />
                )}
                <Button
                  size="sm"
                  variant="primary"
                  className="btn-secondary"
                  title={downloadDisabledReason}
                  disabled={!isDownload}
                  onClick={handleDownload}
                >
                  {t('toolbar.virtualUsbDrive.download')}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  status="danger"
                  className="btn-secondary"
                  loading={isLoading('ftDelFile') || isLoading('ftDelDir')}
                  title={
                    hasFtcacheUploadingConflict
                      ? t('toolbar.virtualUsbDrive.deleteDisabled.ftcacheUploading')
                      : undefined
                  }
                  disabled={!canDeleteSelected || isLoading('ftDelFile') || isLoading('ftDelDir')}
                  onClick={handleDelete}
                >
                  {t('toolbar.virtualUsbDrive.delete')}
                </Button>
                <UploadDropZone
                  ref={uploadDropZoneRef}
                  startMethod="startFtFsUpload"
                  step="overview"
                  formatsText={t('toolbar.virtualUsbDrive.uploadFormatsText')}
                  source="virtual-usb"
                  path={currentPath}
                  httpUploadUrl={env.target === 'device' ? '/ft/upload' : ''}
                  accept="*"
                  beforeUpload={file => {
                    if (file.size === 0) {
                      const { path, name } = startParamsFn(file);
                      handleCreateFile(`${path}/${name}`);
                      return false;
                    }
                    return true;
                  }}
                  maxFileSize={4 * 1000 * 1000 * 1000}
                  startParams={startParamsFn}
                  onStart={onStartUpload}
                  onResumeStart={onResumeStart}
                  onSuccess={onSuccessUpload}
                  onProgress={onProgressUpload}
                  onError={info => {
                    if (info?.name) {
                      setState(info.name, 'failed', info?.error);
                    }
                  }}
                  onPause={info => {
                    // Update state to paused
                    logger.debug('Upload paused', { name: info.name });
                    setState(info.name, 'paused');
                  }}
                  showProgress={false}
                  showInputAlways={true}
                  customUploadTrigger={
                    <Button size="sm" variant="primary" className="btn-primary">
                      {t('toolbar.virtualUsbDrive.uploadFiles')}
                    </Button>
                  }
                />
              </>
            )}
          </>
        }
      >
        <DataTable
          columns={completedColumns(t)}
          list={showCompletedList}
          rowKey="id"
          loading={isLoading('ftListFile')}
          rowHover={true}
          className="mt-[var(--spacing-base)] min-h-0 flex-1 text-sm [&_table]:w-full [&_table]:table-fixed"
          scroll={{ y: 'calc(100vh - 450px)', x: 'max-content' }}
          emptyProps={(() => {
            switch (fileTransferState) {
              case 'None':
                return {
                  icon: <IconUSB className="size-8 opacity-80" />,
                  title: t('toolbar.virtualUsbDrive.empty.notMountedTitle'),
                  description: t('toolbar.virtualUsbDrive.empty.notMountedDesc'),
                  className: 'py-14',
                };
              case 'RemoteUsb':
                return {
                  icon: <IconNoFile className="size-8 opacity-80" />,
                  title: t('toolbar.virtualUsbDrive.empty.remoteUsbTitle'),
                  description: t('toolbar.virtualUsbDrive.empty.remoteUsbDesc'),
                  className: 'py-14',
                };
              case 'Kvm':
                return {
                  icon: <IconNoFile1 className="size-8 opacity-80" />,
                  title: t('toolbar.virtualUsbDrive.empty.noFilesTitle'),
                  description: t('toolbar.virtualUsbDrive.empty.noFilesDesc'),
                  className: 'py-14',
                };
              default:
                return {
                  icon: <IconNoFile className="size-8 opacity-80" />,
                  title: t('toolbar.virtualUsbDrive.empty.noFilesTitle'),
                  description: t('toolbar.virtualUsbDrive.empty.noFilesDesc'),
                  className: 'py-14',
                };
            }
          })()}
          rowSelection={{
            selectedRowKeys: selectedCompletedRowKeys,
            onChange: keys => {
              setSelectedCompletedRowKeys(keys);
            },
            columnWidth: 40,
          }}
          onCellClick={payload => {
            const { record, dataIndex, value } = payload;

            // When clicking folder name, enter that directory: call getCompletedList('/'+name)
            if (dataIndex === 'name' && record?.is_dir) {
              if (value) getCompletedList(`${currentPath}/${value}`);
            }
          }}
        />
      </ActionPanel>
      {fileTransferState === 'Kvm' ? (
        <div className={cn(commandClass, 'border border-[var(--border)]')}>
          <StorageUsage
            totalBytes={ftStorageDetails?.bytesTotal ?? (storageInfo?.total_space ?? 0) * 1024}
            usedBytes={ftStorageDetails?.bytesUsed ?? (storageInfo?.used_space ?? 0) * 1024}
            freeBytes={ftStorageDetails?.bytesFree ?? (storageInfo?.free_space ?? 0) * 1024}
            systemBytes={ftStorageDetails?.categories.find(category => category.id === 'targetOs')?.bytesUsed}
            contentBytes={ftStorageDetails?.categories.find(category => category.id === 'userFiles')?.bytesUsed}
            contentType="userFiles"
            onOpenDetails={() => setStorageDetailsOpen(true)}
            loading={isLoading('ftFileSystemInfo') || isLoading('getFtStorageDetails')}
            title={t('toolbar.virtualUsbDrive.availableStorage')}
            rightText={percent => t('toolbar.virtualUsbDrive.storageDetails.usedPercent', { percent })}
            usedText={bytes => t('toolbar.virtualUsbDrive.storageDetails.usedBytes', { size: formatBytes(bytes) })}
            freeText={bytes => t('toolbar.virtualUsbDrive.storageDetails.freeBytes', { size: formatBytes(bytes) })}
            className="mt-2"
          />
          <StorageDetailsDialog
            open={storageDetailsOpen}
            onOpenChange={setStorageDetailsOpen}
            title={t('toolbar.virtualUsbDrive.storageDetails.title')}
            typeLabel={t('toolbar.virtualUsbDrive.storageDetails.type')}
            usedLabel={t('toolbar.virtualUsbDrive.storageDetails.used')}
            requiredLabel={t('toolbar.virtualUsbDrive.storageDetails.required')}
            closeLabel={t('toolbar.virtualUsbDrive.storageDetails.ok')}
            note={t('toolbar.virtualUsbDrive.storageDetails.targetOsNote')}
            rows={storageRows}
          />
          <StorageDeleteConfirmDialog
            open={deleteAllFilesOpen}
            onOpenChange={setDeleteAllFilesOpen}
            title={t('toolbar.virtualUsbDrive.storageDetails.deleteFilesTitle')}
            description={t('toolbar.virtualUsbDrive.storageDetails.deleteFilesDescription')}
            cancelLabel={t('toolbar.virtualUsbDrive.storageDetails.cancel')}
            confirmLabel={t('toolbar.virtualUsbDrive.storageDetails.deleteAllFiles')}
            onConfirm={confirmDeleteAllFiles}
          />
        </div>
      ) : (
        <></>
      )}
    </div>
  );
}
