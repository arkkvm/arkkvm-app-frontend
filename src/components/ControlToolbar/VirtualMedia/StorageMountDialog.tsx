import { createLogger } from '@/utils/logger';
import { IconCd } from '@/assets/icons';
import type { ArkKvmStorageDetailsResponse, StorageFileInfo } from '@/api/rpc/methods';
import type { JsonRpcHandle } from '@/hooks/useJsonRpc';
import { useLoadingMap } from '@/hooks/useLoading';
import { useAppStore } from '@/stores';
import { formatBytes, mergeUploadLists } from '@/utils/transfer';
import { Plus } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Dialog } from '../../Dialog';
import StorageUsage from '../../StorageUsage';
import { StorageDeleteConfirmDialog, StorageDetailsDialog, type StorageDetailRow } from '../../StorageDetailsDialog';
import TransferList from '../../TransferList';
import { Button } from '../../ui/button';
import { useConfirmDialog } from '../../ui/confirm-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import { LoadingOverlay } from '../../ui/LoadingOverlay';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs';
import UploadDropZone from '../../Upload';
import { type UploadDropZoneRef } from '../../Upload/UploadDropZone';
import { pausedFiles, releaseUploadLock, removeFromQueue } from '../../Upload/uploadLock';
import SelectMountAs from './SelectMountAs';
import StorageFileItem from './StorageFileItem';
import { inferMountAsByUrlSuffix } from './utils';
import { env } from '@/utils';
import {
  deleteUploadTask,
  UploadResumeError,
  type UploadResumeErrorCode,
} from '@/utils/uploadIndexedDb';

const logger = createLogger('StorageMountDialog');

export type StorageMountAs = 'CDROM' | 'Disk';

interface StorageFileItem {
  filename: string;
  size: number;
  modifiedAt?: number;
  incomplete?: boolean;
  state?: string;
  showFileName?: string;
  showUploader?: boolean;
  showPause?: boolean;
  totalBytes?: number;
}

interface StorageMountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBack: () => void;
  onMounted?: (payload: { filename: string; mountAs: StorageMountAs }) => void;
  rpc: JsonRpcHandle;
}

const StorageMountDialog: React.FC<StorageMountDialogProps> = ({
  open,
  onOpenChange,
  onBack,
  onMounted,
  rpc,
}: StorageMountDialogProps) => {
  const { t } = useTranslation('virtualMedia');
  const [storageTab, setStorageTab] = useState<'Available' | 'Uploading'>('Available');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getUploadController = useAppStore(
    (s: any) =>
      s.getUploadController as
        | ((name: string) =>
            | {
                pause?: () => void;
                cancel?: () => void;
                resume?: () => void;
                channel?: { close: () => void };
              }
            | undefined)
        | undefined
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unregisterUpload = useAppStore(
    (s: any) => s.unregisterUpload as ((name: string) => void) | undefined
  );
  const removeUploadController = useAppStore(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s: any) => s.removeUploadController as ((name: string) => void) | undefined
  );

  const uploadDropZoneRef = useRef<UploadDropZoneRef>(null);

  const [send, isReady, sendAsync] = rpc;
  // --- Upload session persistence (restore progress after refresh) ---
  const getBaseName = useCallback((name: string) => name.replace(/\.incomplete$/, ''), []);

  const { is, start, stop, wrap } = useLoadingMap([
    'loadList',
    'mount',
    'upload',
    'listStorageFiles',
    'getStorageDetails',
    'clearStorageLogs',
    'clearStorageImages',
  ]);
  const [files, setFiles] = useState<StorageFileItem[]>([]);
  // const [incompleteFiles, setIncompleteFiles] = useState<StorageFileItem[]>([]); // TODO: use for upload list management

  const [storageDetails, setStorageDetails] = useState<ArkKvmStorageDetailsResponse | null>(null);
  const [storageDetailsOpen, setStorageDetailsOpen] = useState(false);
  const [deleteAllImagesOpen, setDeleteAllImagesOpen] = useState(false);
  const [clearLogsConfirmOpen, setClearLogsConfirmOpen] = useState(false);
  const [selected, setSelected] = useState<StorageFileItem | null>(null);
  const [mountAs, setMountAs] = useState<StorageMountAs>('CDROM');
  const uploadMap = useAppStore(s => s.fileTransferList.byId);
  // Computed list that merges runtime upload tasks with persisted incomplete files
  const uploadingList = useMemo(() => {
    const runtimeUploads = Object.values(uploadMap).filter(it => it.source === 'storage');

    return runtimeUploads;
  }, [uploadMap]);

  const { confirm } = useConfirmDialog();

  const fetchStorageDetails = useCallback(async () => {
    if (!isReady) return;
    const response = await wrap('getStorageDetails', sendAsync({ method: 'getStorageDetails' }));
    if (response.success) setStorageDetails(response.result);
  }, [sendAsync, isReady, wrap]);
  const listStorageFilesAsync = useCallback(async () => {
    if (!isReady) return;
    const { success, result } = (await wrap(
      'listStorageFiles',
      sendAsync({ method: 'listStorageFiles' }, { resultOnly: false })
    )) as { success: boolean; result: { files: StorageFileInfo[] } };
    const normalFiles: StorageFileItem[] = [];
    const incomplete: StorageFileItem[] = [];
    if (!success) return;
    (result.files || []).forEach((it: StorageFileInfo) => {
      const { size, totalBytes } = it;
      const fname = String(it.filename ?? '');
      const newFname = getBaseName(fname);
      it.filename = newFname;
      const isIncompleteFile = /\.incomplete$/.test(fname);
      const isUploading = totalBytes > size;
      if (isIncompleteFile || isUploading) {
        incomplete.push(it);
      } else {
        normalFiles.push(it);
      }
    });
    setFiles(normalFiles);
    setSelected(normalFiles?.[0] || null);
    const pendingFiles: {
      createdAt: string;
      filename: string;
      size: number;
      totalBytes: number;
    }[] = incomplete.map(item => ({
      createdAt: (item as StorageFileInfo).createdAt || new Date().toISOString(),
      filename: item.filename,
      size: item.size,
      totalBytes: item.totalBytes || item.size,
    }));
    const mergedUploadList = mergeUploadLists(pendingFiles, uploadingList);
    try {
      const persistPayload = mergedUploadList.map(item => ({
        id: item.id,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        // Persist only core fields required for storage;
        // runtime-only fields are initialized by hydrate
        source: item.source,
        direction: item.direction,
        path: item.path,
        name: item.name,
        totalBytes: item.totalBytes,
        transferredBytes: item.transferredBytes,
        progress: item.progress,
      }));
      localStorage.setItem('transfer:list', JSON.stringify(persistPayload));
      // Re-hydrate upload list after overwrite to keep UI in sync
      useAppStore.getState().fileTransferList.hydrate('storage');
    } catch {
      // Silent fallback on persistence failure
    }
  }, [sendAsync, isReady, wrap, uploadingList]);
  const load = useCallback(async () => {
    setStorageTab('Available');
    await Promise.all([listStorageFilesAsync(), fetchStorageDetails()]);
  }, [listStorageFilesAsync, fetchStorageDetails, setStorageTab]);

  const handleDeleteAllImages = useCallback(async () => {
    const { success, error } = await sendAsync(
      { method: 'clearStorageImages' },
      { showUnhandledErrorToast: false }
    );
    if (!success) {
      toast.error(t('storageDialog.details.imagesDeleteFailed'));
      throw new Error(error.message);
    }
    await Promise.all([listStorageFilesAsync(), fetchStorageDetails()]);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setDeleteAllImagesOpen(false);
    setStorageDetailsOpen(false);
    toast.success(t('storageDialog.details.imagesDeleted'));
  }, [sendAsync, listStorageFilesAsync, fetchStorageDetails, t]);

  const handleClearLogs = useCallback(async () => {
    const { success, error } = await sendAsync(
      { method: 'clearStorageLogs' },
      { showUnhandledErrorToast: false }
    );
    if (!success) {
      toast.error(t('storageDialog.details.clearLogsFailed'));
      throw new Error(error.message);
    }
    await fetchStorageDetails();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setClearLogsConfirmOpen(false);
    toast.success(t('storageDialog.details.logsCleared'));
  }, [sendAsync, fetchStorageDetails, t]);
  useEffect(() => {
    if (isReady) {
      // syncGetFileTransferState(true)
      useAppStore.getState().fileTransferList.hydrate();
      useAppStore.getState().fileTransferList.updateProgress();
      load();
      return;
    } else {
      // On disconnect, convert all running tasks to paused
      const { fileTransferList, fileDownloadList } = useAppStore.getState();

      // Handle upload tasks
      Object.values(fileTransferList.byId).forEach(upload => {
        if (upload.state === 'running') {
          fileTransferList.setState(upload.id, 'paused');
        }
      });

      // Handle download tasks
      Object.values(fileDownloadList.byId).forEach(download => {
        if (download.state === 'running') {
          // fileDownloadList has no setState method, skip for now
          // fileDownloadList.setState(download.id, 'paused');
        }
      });
    }
  }, [isReady]);

  const handleMount = useCallback(async () => {
    if (!selected) return;
    start('mount');
    const doMount = async () =>
      sendAsync(
        {
          method: 'mountWithStorage',
          params: { filename: selected.filename, mode: mountAs },
        },
        { resultOnly: true, showUnhandledErrorToast: true }
      );
    try {
      await doMount();
      onMounted?.({ filename: selected.filename, mountAs });
      onOpenChange(false);
    } catch (err: unknown) {
      const errObj = err as { code?: number; message?: string; data?: unknown };
      const code = errObj?.code ?? (errObj?.data as { code?: number } | undefined)?.code;
      const msg = String(errObj?.message || errObj?.data || '');
      const alreadyMounted = code === -32603 && /already mounted/i.test(msg || '');
      if (alreadyMounted) {
        try {
          // auto unmount then retry
          await sendAsync({ method: 'unmountImage' }, { resultOnly: true });
          await doMount();
          onMounted?.({ filename: selected.filename, mountAs });
          onOpenChange(false);
        } catch {
          toast.error('Mount failed after unmount');
        } finally {
          stop('mount');
        }
        return;
      }
      toast.error('Mount failed');
    } finally {
      stop('mount');
    }
  }, [selected, mountAs, sendAsync, start, stop, onMounted, onOpenChange]);

  // Unified delete handler shared by available-image list and upload list
  const handleDeleteFile = useCallback(
    (file: { filename?: string }) => {
      let rawFileName = String(file.filename ?? '');
      if (file?.direction === 'upload') {
        rawFileName = `${rawFileName}.incomplete`;
      }
      const displayName = rawFileName.replace(/\.incomplete$/, '');

      confirm({
        title: t('storageDialog.deleteFile'),
        content: t('storageDialog.deleteFileDesc', { displayName }),
        type: 'error',
        confirmText: t('storageDialog.delete'),
        cancelText: t('storageDialog.cancel'),
        onConfirm: () => {
          // Cleanup local upload session and its DataChannel
          try {
            const baseName = displayName;
            const ctrls = [
              getUploadController?.(rawFileName),
              baseName ? getUploadController?.(baseName) : undefined,
            ].filter(
              (c): c is NonNullable<ReturnType<NonNullable<typeof getUploadController>>> =>
                c != null
            );

            ctrls.forEach(c => {
              try {
                c?.channel?.close();
              } catch {}
            });

            unregisterUpload?.(rawFileName);
            if (baseName && baseName !== rawFileName) {
              unregisterUpload?.(baseName);
            }
            removeUploadController?.(rawFileName);
            if (baseName && baseName !== rawFileName) {
              removeUploadController?.(baseName);
            }
          } catch {}

          // Release upload lock, clear pause markers, and remove queued items
          releaseUploadLock();
          pausedFiles.delete(displayName);
          pausedFiles.delete(rawFileName);
          removeFromQueue(displayName);
          removeFromQueue(rawFileName);

          send({
            method: 'deleteStorageFile',
            params: {
              filename: rawFileName,
            },
            onResponse() {
              toast.success(t('storageDialog.fileDeleted'));
              load();
            },
          });
        },
      });
    },
    [send, load, confirm, getUploadController, unregisterUpload, removeUploadController, t]
  );

  // Bridge storage uploads with global upload list (fileTransferListSlice)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createUploadRow = useAppStore((s: any) => s.fileTransferList?.createRow);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const removeRow = useAppStore((s: any) => s.fileTransferList?.removeRow);
  const updateProgress = useAppStore(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s: any) => s.fileTransferList?.updateProgress
  );
  const setUploadRowState = useAppStore(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s: any) => s.fileTransferList?.setState
  );
  // Map filename -> uploadRowId for progress updates
  const uploadRowIdRef = useRef<Record<string, string>>({});

  // Reuse handleDeleteFile for upload-list deletion actions
  const handleDeleteUploadingRow = useCallback(
    (id: string) => {
      const row = uploadingList.find(it => it.id === id);
      if (!row) return;
      const rawFileName = `${row.name}.incomplete`;
      const displayName = row.name;

      confirm({
        title: t('storageDialog.deleteFile'),
        content: t('storageDialog.deleteFileDesc', { displayName }),
        type: 'error',
        confirmText: t('storageDialog.delete'),
        cancelText: t('storageDialog.cancel'),
        onConfirm: () => {
          // First pause the upload (this will release lock and process queue)
          const ctrl = getUploadController?.(rawFileName) || getUploadController?.(displayName);
          if (ctrl?.pause) {
            ctrl.pause();
          }

          // Then cleanup upload controllers and DataChannel
          try {
            const ctrls = [
              getUploadController?.(rawFileName),
              getUploadController?.(displayName),
            ].filter(Boolean);
            ctrls.forEach(c => {
              // Call cancel method if exists (will abort XHR and close DataChannel)
              try {
                c?.cancel?.();
              } catch {}
              // Fallback: manually close channel
              try {
                c?.channel?.close();
              } catch {}
            });
            unregisterUpload?.(rawFileName);
            unregisterUpload?.(displayName);
            removeUploadController?.(rawFileName);
            removeUploadController?.(displayName);
          } catch {}

          // Clear pause markers and remove queued items
          pausedFiles.delete(displayName);
          pausedFiles.delete(rawFileName);
          removeFromQueue(displayName);
          removeFromQueue(rawFileName);

          // Delete file on device side
          send({
            method: 'deleteStorageFile',
            params: { filename: rawFileName },
            onResponse() {
              toast.success(t('storageDialog.fileDeleted'));
              // Just refresh the list without switching tabs
              listStorageFilesAsync();
              fetchStorageDetails();
            },
          });

          // Remove this row from upload task list and IndexedDB persistence
          try {
            removeRow?.(id);
          } catch {}
          try {
            deleteUploadTask(id);
          } catch {}
        },
      });
    },
    [
      uploadingList,
      confirm,
      t,
      send,
      load,
      removeRow,
      getUploadController,
      unregisterUpload,
      removeUploadController,
      listStorageFilesAsync,
      fetchStorageDetails,
    ]
  );

  const onContinueUpload = useCallback(
    (index: number) => {
      const file = files[index];
      if (!file) return;
      // Prefer direct resume via upload controller
      // (avoid forcing user to reselect file)
      try {
        const rawName = String(file.filename ?? '');
        const baseName = getBaseName(rawName);
        const displayName = file.showFileName || baseName || rawName;
        const candidates = [displayName, rawName, baseName].filter(Boolean);
        const ctrl = candidates.map(k => getUploadController?.(k)).find(Boolean);
        if (ctrl && typeof ctrl.resume === 'function') {
          ctrl.resume();
          setFiles(prev => {
            const next = [...prev];
            const item = next[index];
            if (item) {
              item.state = 'uploading';
              item.showUploader = true;
            }
            return next;
          });
          return;
        }
      } catch {}

      // Fallback when controller is missing: show uploader
      // and let user reselect file with same name
      file.showUploader = true;
      setFiles([...files]);
    },
    [files, getUploadController]
  );

  const onStateChange = useCallback(
    (state: string, index: number) => {
      const file = files[index];
      if (!file) return;
      if (state === 'success') {
        file.state = 'idle';
        file.showUploader = false;
      } else {
        file.state = state;
        setFiles([...files]);
      }
    },
    [files]
  );

  const onSelectImage = useCallback((file: StorageFileItem) => {
    setSelected(file);
    const getMountAs = inferMountAsByUrlSuffix(file.filename || 'CDROM');
    setMountAs(getMountAs);
    // const ext = file.filename?.toLowerCase();
    // if (ext?.endsWith('.iso')) {
    //   setMountAs('CDROM');
    // } else if (ext?.endsWith('.img')) {
    //   setMountAs('Disk');
    // }
  }, []);
  const onSuccessUpload = useCallback(
    file => {
      start('listStorageFiles');
      setTimeout(() => {
        load();
        removeRow(file?.name);
      }, 2000);

      // getCompletedList(currentPath)
      // getFtFileSystemInfo()

      //name
    },
    [load]
  );
  const onStartUpload = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (payload: { filename: string; size: number; dataChannel: any }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { filename, size, dataChannel } = payload || ({} as any);
      if (!filename || !size || !createUploadRow) return;

      const label = typeof dataChannel === 'string' ? dataChannel : dataChannel?.label || 'upload';
      const id = createUploadRow({
        path: '/',
        name: filename,
        totalBytes: size,
        dataChannel: label,
        source: 'storage',
        direction: 'upload',
      });
      // Don't set state here - let useUpload manage it via registerUpload
      // (will be 'waiting' if queued, 'uploading' if started immediately)
      setStorageTab('Uploading');
      uploadRowIdRef.current[filename] = id;
    },
    [createUploadRow]
  );
  const onProgressUpload = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (data: any) => {
      const { name } = data;
      if (!name) return;
      updateProgress(name, data);
    },
    [updateProgress]
  );
  const handlePauseUpload = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (row: any) => {
      const ctrl = getUploadController?.(row.name) || getUploadController?.(row.id);
      if (ctrl?.pause) {
        ctrl.pause();
      }
      setUploadRowState?.(row.id, 'paused');
    },
    [getUploadController, setUploadRowState]
  );

  const onError = useCallback(
    (data: { name: string; error: string }) => {
      const { name, error } = data || {};

      // Keep the failed upload in the list: mark it as `failed` (existing
      // TransferState) instead of removing it, so the user can retry or delete.
      const uploadId = uploadRowIdRef.current[name];
      if (uploadId && setUploadRowState) {
        try {
          setUploadRowState(uploadId, 'failed', error);
        } catch (e) {
          logger.error('Failed to mark upload row as failed', e);
        }
      }
    },
    [setUploadRowState]
  );

  const onResumeStart = useCallback(
    (payload: { filename: string; taskId?: string }) => {
      const { filename, taskId } = payload || {};
      const id = taskId || uploadRowIdRef.current[filename];
      if (filename && id) {
        uploadRowIdRef.current[filename] = id;
      }
      if (id && setUploadRowState) {
        try {
          setUploadRowState(id, 'running');
        } catch (e) {
          logger.error('Failed to mark upload row as running on resume', e);
        }
      }
    },
    [setUploadRowState]
  );

  const handleResumeUpload = useCallback(
    async (row: { id: string; name: string }) => {
      // 1) Prefer an in-session upload controller (pause/continue in same tab).
      const ctrl = getUploadController?.(row.name) || getUploadController?.(row.id);
      if (ctrl && typeof ctrl.resume === 'function') {
        try {
          ctrl.resume();
          setUploadRowState?.(row.id, 'running');
          return;
        } catch {
          // Fall through to persisted resume or fallback picker.
        }
      }

      // 2) Try persisted File System Access resume.
      try {
        await uploadDropZoneRef.current?.resumeUpload(row.id);
        return;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // 3) If the persisted task/handle cannot be used, let the user
        //    re-select the original file and resume from the device offset.
        const recoverableCodes = new Set<UploadResumeErrorCode>([
          'file-missing',
          'not-supported',
          'permission-denied',
        ]);
        const isRecoverable = err instanceof UploadResumeError && recoverableCodes.has(err.code);

        if (isRecoverable) {
          uploadDropZoneRef.current?.openFilePicker();
          return;
        }
        toast.error(message || 'Resume upload failed');
        if (setUploadRowState) {
          try {
            setUploadRowState(row.id, 'failed', message);
          } catch {}
        }
      }
    },
    [getUploadController, setUploadRowState]
  );

  const storageCategoryActions = new Map<string, { label: string; onClick: () => void }>([
    ['logs', {
      label: t('storageDialog.details.clearLogs'),
      onClick: () => setClearLogsConfirmOpen(true),
    }],
    ['images', {
      label: t('storageDialog.details.clearImages'),
      onClick: () => setDeleteAllImagesOpen(true),
    }],
  ]);

  const storageRows: StorageDetailRow[] = (storageDetails?.categories ?? []).map(category => {
    const action = storageCategoryActions.get(category.id);

    return {
      label: t(`storageDialog.details.categories.${category.id}`, {
        defaultValue: category.label,
      }),
      bytes: category.bytesUsed,
      required: !category.clearable,
      actionLabel: action?.label,
      onAction: action?.onClick,
      actionDisabled: category.clearable && category.bytesUsed === 0,
    };
  });

  return (
    <>
      {open && !storageDetailsOpen && !deleteAllImagesOpen && !clearLogsConfirmOpen && (
        <Dialog
          title={
            storageTab === 'Available'
              ? t('storageDialog.titleAvailable')
              : t('storageDialog.titleUploading')
          }
          description={
            storageTab === 'Available'
              ? t('storageDialog.descAvailable')
              : t('storageDialog.descUploading')
          }
          contentClassName="z-[200] top-[calc(env(safe-area-inset-top)+72px)] max-h-[calc(100dvh-env(safe-area-inset-top)-88px)] translate-y-0 gap-3 p-4 pb-0 sm:top-[50%] sm:max-h-[85vh] sm:translate-y-[-50%] sm:gap-4 sm:p-6 sm:pb-0"
          width="min(720px, calc(100vw - 24px))"
          open={open}
          onOpenChange={onOpenChange}
          onCancel={() => onOpenChange(false)}
          footerSlot={<></>}
        >
          <Tabs
            value={storageTab}
            onValueChange={v => setStorageTab(v as 'Available' | 'Uploading')}
            className="w-full"
            size="sm"
          >
            <TabsList className="m-auto h-[32px] bg-(--bg-secondary)">
              <TabsTrigger value="Available" className="h-[28px]">
                {t('storageDialog.tabAvailable')}
              </TabsTrigger>
              <TabsTrigger value="Uploading" className="h-[28px]">
                {t('storageDialog.tabUploading')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="Available">
              <LoadingOverlay
                visible={is('listStorageFiles')}
                text={t('storageDialog.loadingFiles')}
                className="absolute inset-0 z-10 pointer-events-none"
                layout="col"
              />

              <div className="space-y-3 sm:space-y-4">
                <div className="min-h-[180px] max-h-[260px] overflow-y-auto rounded-md border border-(--border-color) sm:min-h-[236px] sm:max-h-[350px]">
                  {files.length ? (
                    files.map((file, _index) => {
                      try {
                        // Only pass the fields that StorageFileItem expects
                        const fileForItem = {
                          filename: file.filename,
                          size: file.size,
                          incomplete: file.incomplete,
                          state: file.state,
                        };
                        return (
                          <StorageFileItem
                            key={file.filename}
                            file={fileForItem}
                            selected={selected?.filename === file.filename}
                            onSelect={onSelectImage}
                            onContinueUpload={filename => onContinueUpload(filename, 0)}
                            onDelete={handleDeleteFile}
                          />
                        );
                      } catch (e) {
                        logger.error('StorageFileItem render failed', e);
                        return (
                          <div
                            key={file.filename}
                            className="p-2 border-b border-red-500 text-red-500"
                          >
                            Error rendering {file.filename}: {String(e)}
                          </div>
                        );
                      }
                    })
                  ) : (
                    <div className="flex min-h-[180px] max-h-[260px] items-center justify-center gap-2 p-4 text-sm sm:min-h-[236px] sm:max-h-[350px]">
                      <div className="flex flex-col items-center">
                        <IconCd className="size-8 opacity-80" />
                        <span className="text-(--text-secondary)">{t('storageDialog.noFiles')}</span>
                        <p className="text-text">{t('storageDialog.noFilesDesc')}</p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Mount as */}
                <SelectMountAs
                  value={mountAs}
                  onChange={setMountAs}
                  rightSlot={
                    <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                      <UploadDropZone
                        showProgress={false}
                        startMethod="startStorageFileUpload"
                        httpUploadUrl={env.target === 'device' ? '/storage/upload' : ''}
                        step="overview"
                        className="mb-0 min-w-0 flex-1 border-dashed sm:flex-none"
                        uploaderContainerClassName="cursor-pointer"
                        resumeFileName=""
                        source="storage"
                        path="/"
                        customUploadTrigger={
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="sm"
                                className="btn-primary min-w-0 flex-1 cursor-pointer whitespace-nowrap sm:flex-none"
                              >
                                <Plus className="size-[16px] mr-0" />
                                {t('storageDialog.uploadImageButton')}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              {t('storageDialog.uploadImageTooltip')}
                            </TooltipContent>
                          </Tooltip>
                        }
                        formatsText={
                          <>
                            <span className="font-medium">{t('storageDialog.formatsTypes')}</span>
                          </>
                        }
                        idleText={
                          <div className="flex flex-col items-center ">
                            <Button className="rounded-[50%] w-[40px] h-[40px] mb-[10px] cursor-pointer">
                              <Plus className="size-5 opacity-60" />
                            </Button>

                            <span>{t('storageDialog.idleText')}</span>
                          </div>
                        }
                        draggingText={t('storageDialog.draggingText')}
                        onSuccess={onSuccessUpload}
                        onStart={onStartUpload}
                        onResumeStart={onResumeStart}
                        onProgress={onProgressUpload}
                        onStateChange={onStateChange}
                        rpc={rpc}
                      >
                        <Button className="w-full">
                          {/*  onClick={() => setStorageTab('Uploading')} */}
                          {t('storageDialog.uploadNewImage')}
                        </Button>
                      </UploadDropZone>
                      <Button size="sm" className="min-w-[72px] flex-1 sm:flex-none" onClick={onBack}>
                        {t('storageDialog.back')}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        className="min-w-[72px] flex-1 sm:flex-none"
                        loading={is('mount')}
                        disabled={!selected || selected.incomplete}
                        onClick={handleMount}
                      >
                        {t('storageDialog.mountFile')}
                      </Button>
                    </div>
                  }
                ></SelectMountAs>
                {/* Storage usage */}
              </div>
              <StorageUsage
                totalBytes={storageDetails?.bytesTotal || 0}
                usedBytes={storageDetails?.bytesUsed || 0}
                freeBytes={storageDetails?.bytesFree || 0}
                systemBytes={
                  storageDetails?.categories.find(category => category.id === 'system')?.bytesUsed
                }
                logBytes={
                  storageDetails?.categories.find(category => category.id === 'logs')?.bytesUsed
                }
                contentBytes={
                  storageDetails?.categories.find(category => category.id === 'images')?.bytesUsed
                }
                contentType="images"
                onOpenDetails={() => setStorageDetailsOpen(true)}
                loading={is('getStorageDetails')}
                title={t('storageDialog.availableStorage')}
                rightText={pct => t('storageDialog.usedPct', { pct })}
                usedText={used => t('storageDialog.usedText', { used: formatBytes(used) })}
                freeText={free => t('storageDialog.freeText', { free: formatBytes(free) })}
                mountKey={storageTab}
                className="mt-2"
              />
            </TabsContent>

            <TabsContent value="Uploading">
              {/* <DataTable
              columns={uploadingColumns}
              list={uploadingList}
              rowKey="id"
              className="text-sm mt-[var(--spacing-base)] [&_table]:table-fixed [&_table]:w-full"
              scroll={{ x: 'max-content' }}
              emptyProps={{
                icon: <IconCd className="size-8 opacity-80" />,
                title: t('storageDialog.noCurrentUploads'),
                description: t('storageDialog.noCurrentUploadsDesc'),
                className: 'py-14', // Optional: custom height/spacing
              }}
            /> */}
              {/*   onPause={env.target !== 'device' ? handlePauseUpload : undefined} */}
              <TransferList
                list={uploadingList}
                onPause={handlePauseUpload}
                onRemove={handleDeleteUploadingRow}
                onResume={handleResumeUpload}
                // showActions={false}
                emptyProps={{
                  icon: <IconCd className="size-8 opacity-80" />,
                  title: t('storageDialog.noCurrentUploads'),
                  description: t('storageDialog.noCurrentUploadsDesc'),
                  className: 'pt-14',
                }}
              />
              <div className="flex items-center justify-end gap-2  py-(--spacing-base)">
                <Button onClick={onBack}>{t('storageDialog.back')}</Button>
              </div>
              <UploadDropZone
                ref={uploadDropZoneRef}
                showProgress={false}
                startMethod="startStorageFileUpload"
                httpUploadUrl={env.target === 'device' ? '/storage/upload' : ''}
                step="overview"
                className="mb-0 m-0 border-dashed cursor-pointer"
                resumeFileName=""
                source="storage"
                path="/"
                formatsText={
                  <>
                    <span className="font-medium">{t('storageDialog.formatsTypes')}</span>
                  </>
                }
                idleText={
                  <div className="flex flex-col items-center">
                    <Button className="rounded-[50%] w-[40px] h-[40px] mb-[10px] cursor-pointer">
                      <Plus className="size-5 opacity-60" />
                    </Button>

                    <span>{t('storageDialog.idleText')}</span>
                  </div>
                }
                draggingText={t('storageDialog.draggingText')}
                onSuccess={onSuccessUpload}
                onStart={onStartUpload}
                onResumeStart={onResumeStart}
                onProgress={onProgressUpload}
                onStateChange={onStateChange}
                onError={onError}
                rpc={rpc}
              >
                <Button className="w-full cursor-pointer">
                  {/*  onClick={() => setStorageTab('Uploading')} */}
                  {t('storageDialog.uploadNewImage')}
                </Button>
              </UploadDropZone>
            </TabsContent>
          </Tabs>
        </Dialog>
      )}
      {storageDetailsOpen && !deleteAllImagesOpen && !clearLogsConfirmOpen && (
        <StorageDetailsDialog
          open={storageDetailsOpen}
          onOpenChange={setStorageDetailsOpen}
          title={t('storageDialog.details.title')}
          typeLabel={t('storageDialog.details.type')}
          usedLabel={t('storageDialog.details.used')}
          requiredLabel={t('storageDialog.details.required')}
          closeLabel={t('storageDialog.details.ok')}
          note={t('storageDialog.details.systemNote')}
          rows={storageRows}
        />
      )}
      {clearLogsConfirmOpen && (
        <StorageDeleteConfirmDialog
          open={clearLogsConfirmOpen}
          onOpenChange={setClearLogsConfirmOpen}
          title={t('storageDialog.details.clearLogsTitle')}
          description={t('storageDialog.details.clearLogsDescription')}
          cancelLabel={t('storageDialog.cancel')}
          confirmLabel={t('storageDialog.details.clearLogs')}
          onConfirm={handleClearLogs}
        />
      )}
      {deleteAllImagesOpen && (
        <StorageDeleteConfirmDialog
          open={deleteAllImagesOpen}
          onOpenChange={setDeleteAllImagesOpen}
          title={t('storageDialog.details.deleteImagesTitle')}
          description={t('storageDialog.details.deleteImagesDescription')}
          cancelLabel={t('storageDialog.cancel')}
          confirmLabel={t('storageDialog.details.deleteAllImages')}
          onConfirm={handleDeleteAllImages}
        />
      )}
    </>
  );
};

export default memo(StorageMountDialog);
