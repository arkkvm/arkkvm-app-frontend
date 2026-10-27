import { generateTaskId, useFileDownload } from '@/hooks/useFileDownload';
import type { FtStorageDetailsResponse } from '@/api/rpc/methods';
import { useLoadingMap } from '@/hooks/useLoading';
import { useAppStore } from '@/stores';
import type { DownloadItem } from '@/stores/slices/fileTransferDownloadSlice';
import type { TransferRow } from '@/stores/slices/fileTransferListSlice';
import { createLogger } from '@/utils/logger';
import { env } from '@/utils/env';
import { humanSize } from '@/utils/format';
import { toast } from 'sonner';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirmDialog } from '../../ui/confirm-dialog';
import { Input } from '../../ui/input';
import { removeFromQueue } from '../../Upload/uploadLock';
import type { UploadDropZoneRef } from '../../Upload/UploadDropZone';
import type { DeleteResult, Row, StorageInfo, VirtualUsbDriveProps, VMState } from './types';
import { filterTasksByFtcache, joinPath } from './utils';
import {
  deleteUploadTask,
  UploadResumeError,
  type UploadResumeErrorCode,
} from '@/utils/uploadIndexedDb';

const logger = createLogger('VirtualUsbDrive');

export function useVirtualUsbDrive({ rpc }: VirtualUsbDriveProps) {
  const { t } = useTranslation('common');
  // Prefer external rpc; fallback to local creation if not provided (backward compatibility)
  const [send, isConnected, sendAsync] = rpc;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getFileNameByKey = useAppStore((s: any) => s.getFileNameByKey);
  const uploadMap = useAppStore(s => s.fileTransferList.byId);
  const uploads = Object.values(uploadMap).filter(item => item.source === 'virtual-usb');
  const { createRow, updateProgress, removeRow, setState } =
    useAppStore.getState().fileTransferList;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getUploadController = useAppStore((s: any) => s.getUploadController);

  // Upload operation callbacks
  const handlePauseUpload = useCallback(
    (row: TransferRow) => {
      logger.warn('handlePauseUpload called', {
        rowId: row.id,
        rowName: row.name,
      });
      const controller = getUploadController?.(row.id);
      logger.warn('controller lookup', {
        found: !!controller,
        hasPause: !!controller?.pause,
        controllerState: controller?.getState?.(),
      });
      if (controller?.pause) {
        controller.pause();
        logger.warn('pause() called, new state:', controller.getState?.());
        // Update UI state to paused immediately (do not wait for callback latency)
        setState(row.id, 'paused');
      } else {
        logger.error('No controller found for', row.id);
        // Still update UI state
        setState(row.id, 'paused');
      }
    },
    [getUploadController, setState]
  );

  const removeUploadController = useAppStore(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s: any) => s.removeUploadController
  );

  const handleRemoveUpload = useCallback(
    (id: string) => {
      // Remove from upload queue (pending tasks)
      // id is usually filename; try both id and getFileNameByKey mapping
      const fileName = getFileNameByKey?.(id) || id;
      removeFromQueue(fileName);

      // Close DataChannel first and cleanup controller to avoid leaks
      const controller = getUploadController?.(id);
      if (controller) {
        const ch = controller.channel as RTCDataChannel | undefined;
        if (ch) {
          try {
            ch.onmessage = null;
            ch.onbufferedamountlow = null;
            ch.onerror = null;
            ch.onclose = null;
            if (ch.readyState === 'open' || ch.readyState === 'connecting') {
              ch.close();
            }
          } catch {}
        }
        try {
          removeUploadController?.(id);
        } catch {}
      }
      removeRow(id);
      try {
        deleteUploadTask(id);
      } catch {}
    },
    [removeRow, getUploadController, removeUploadController, getFileNameByKey]
  );

  const [selectedCompletedRowKeys, setSelectedCompletedRowKeys] = useState<React.Key[]>([]);
  const {
    is: isLoading,
    start: startLoading,
    stop: stopLoading,
    wrap,
  } = useLoadingMap([
    'getFileTransferState',
    'ftDelFile',
    'ftDelDir',
    'mountWithFileImg',
    'ftCreateDir',
    'ftListFile',
    'ftFileSystemInfo',
    'deleteAllFiles',
    'getFtStorageDetails',
  ]);
  const [fileTransferState, setFileTransferState] = useState<VMState>('None');
  const [currentPath, setCurrentPath] = useState<string>('/');
  const currentPathRef = useRef(currentPath);
  const refreshTimerRef = useRef<number | null>(null);
  currentPathRef.current = currentPath;
  const [listType, setListType] = useState<'completed' | 'transfer'>('completed');
  const [completedList, setCompletedList] = useState<Row[]>([]);
  const [transferType, setTransferType] = useState<'upload' | 'download'>('upload');
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadDropZoneRef = useRef<UploadDropZoneRef>(null);
  const {
    setDownloadFileList,
    updateProgress: updateProgressDownload,
    removeRow: removeDownloadRow,
  } = useAppStore.getState().fileDownloadList;
  const [downloadFile, downloadFileCancel] = useFileDownload({
    transport: env.target === 'device' ? 'http-stream' : 'webrtc',
    httpDownloadUrl: env.target === 'device' ? '/ft/file' : undefined,
    onStart: task => {
      logger.debug('Download started', { name: task.name });
      updateProgressDownload(
        task.id,
        task as import('@/stores/slices/fileTransferDownloadSlice').DownloadItem
      );
    },
    onProgress: task => {
      logger.debug('Download progress', {
        name: task.name,
        progress: task.progress,
      });
      if (task.progress === 100) {
        removeDownloadRow(task.id);
      } else {
        updateProgressDownload(
          task.id,
          task as import('@/stores/slices/fileTransferDownloadSlice').DownloadItem
        );
      }
    },
    onComplete: task => {
      logger.info('Download completed', { name: task.name, path: task.path });
      removeDownloadRow(task.id);
    },
    onError: (task, err) => {
      logger.error('Download failed', { name: task.name, error: err });
      updateProgressDownload(task.id, {
        ...task,
        state: 'failed',
      } as import('@/stores/slices/fileTransferDownloadSlice').DownloadItem);
    },
  });
  const downloadsMap = useAppStore(s => s.fileDownloadList.byId);
  const downloads = Object.values(downloadsMap);

  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>({
    free_space: 0,
    total_space: 0,
    used_space: 0,
  });
  const [ftStorageDetails, setFtStorageDetails] = useState<
    | (Omit<FtStorageDetailsResponse, 'categories'> & {
        categories: (Omit<FtStorageDetailsResponse['categories'][number], 'id'> & { id: string })[];
      })
    | null
  >(null);

  const runningUploadTaskNames = useMemo(() => {
    return new Set(uploads.filter(upload => upload.state === 'running').map(upload => upload.name));
  }, [uploads]);

  const showCompletedList = useMemo(() => {
    if (fileTransferState !== 'Kvm') return [];
    return completedList.filter(item => {
      if (item.is_dir || !item.name?.endsWith('.ftcache')) return true;
      const taskName = item.name.replace(/\.ftcache$/i, '');
      return !runningUploadTaskNames.has(taskName);
    });
  }, [fileTransferState, completedList, runningUploadTaskNames]);

  const { confirm } = useConfirmDialog();
  const selectedCompletedRows = useMemo(
    () => showCompletedList.filter((item, i) => selectedCompletedRowKeys.includes(i)),
    [showCompletedList, selectedCompletedRowKeys]
  );

  const hasFtcacheUploadingConflict = useMemo(() => {
    return selectedCompletedRows.some(item => {
      if (item.is_dir || !item.name?.endsWith('.ftcache')) return false;
      const taskName = item.name.replace(/\.ftcache$/i, '');
      return runningUploadTaskNames.has(taskName);
    });
  }, [selectedCompletedRows, runningUploadTaskNames]);

  const hasDirSelected = useMemo(() => {
    return selectedCompletedRows.some(item => item.is_dir);
  }, [selectedCompletedRows]);

  const canDeleteSelected = useMemo(() => {
    return selectedCompletedRowKeys.length > 0 && !hasFtcacheUploadingConflict;
  }, [selectedCompletedRowKeys, hasFtcacheUploadingConflict]);

  const downloadDisabledReason = useMemo(() => {
    if (selectedCompletedRows.length === 0) return undefined;
    if (hasDirSelected) {
      return t('toolbar.virtualUsbDrive.downloadDisabled.folder');
    }
    if (hasFtcacheUploadingConflict) {
      return t('toolbar.virtualUsbDrive.downloadDisabled.ftcacheUploading');
    }
    return undefined;
  }, [selectedCompletedRows, hasDirSelected, hasFtcacheUploadingConflict, t]);

  const isDownload = useMemo(() => {
    return selectedCompletedRows.length > 0 && !downloadDisabledReason;
  }, [selectedCompletedRows, downloadDisabledReason]);

  // Check if there are active upload or download tasks (excluding paused state)
  const hasActiveTransfers = useMemo(() => {
    // Check upload tasks - only check running tasks, exclude paused state
    const hasActiveUploads = uploads.some(upload => upload.state === 'running');

    // Check download tasks - only check running tasks, exclude paused state
    const hasActiveDownloads = downloads.some(download => download.state === 'running');

    return hasActiveUploads || hasActiveDownloads;
  }, [uploads, downloads]);

  // --- breadcrumb helpers ---
  const truncateBytes = useCallback((input: string, maxBytes = 10) => {
    const enc = new TextEncoder();
    let out = '';
    let bytes = 0;
    for (const ch of input) {
      const size = enc.encode(ch).length;
      if (bytes + size > maxBytes) {
        return out + '...';
      }
      out += ch;
      bytes += size;
    }
    return out || '/';
  }, []);

  // --- RPC operations ---
  const getFtFileSystemInfo = useCallback(async () => {
    if (!isConnected) return;
    startLoading('ftFileSystemInfo');
    try {
      const ftFileSystemInfo = await sendAsync(
        {
          method: 'ftFileSystemInfo',
        },
        {
          resultOnly: true,
        }
      );
      logger.info('ftFileSystemInfo result', { result: ftFileSystemInfo });
      setStorageInfo((ftFileSystemInfo as StorageInfo | null | undefined) ?? null);
    } finally {
      stopLoading('ftFileSystemInfo');
    }
  }, [sendAsync, isConnected, wrap, startLoading, stopLoading]);

  const getFtStorageDetails = useCallback(async () => {
    if (!isConnected) return;
    const response = await wrap(
      'getFtStorageDetails',
      sendAsync({ method: 'getFtStorageDetails' })
    );
    if (response.success) {
      setFtStorageDetails(response.result);
    }
  }, [sendAsync, isConnected, wrap]);

  const getCompletedList = useCallback(
    async (path = '/') => {
      startLoading('ftListFile');
      try {
        const result = await sendAsync(
          {
            method: 'ftListFile',
            params: {
              path: joinPath(path),
            },
          },
          {
            resultOnly: true,
          }
        );

        if (Array.isArray(result)) {
          setSelectedCompletedRowKeys([]);
          setCurrentPath(path);
          setCompletedList(result || []);

          // Sync upload task list with device-side .ftcache files
          // Keep only tasks that still have cache on device; remove completed/invalid ones
          const {
            fileTransferList,
            controllers,
            removeUploadController: rmCtrl,
          } = useAppStore.getState();
          const currentUploads = Object.values(fileTransferList.byId).filter(
            (item: TransferRow) => item.source === 'virtual-usb'
          );
          const validTasks = filterTasksByFtcache(result, currentUploads, path);
          const validIds = new Set(validTasks.map(t => t.id));

          // Remove paused tasks in current directory that are not in validIds
          // Keep waiting tasks (running/pending); only clean paused tasks with no device cache
          currentUploads.forEach((task: TransferRow) => {
            if (task.path === path && task.state === 'paused' && !validIds.has(task.id)) {
              // Cleanup potentially stale DataChannel and controller as well
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const ctrl = (controllers as any)?.[task.id];
              if (ctrl) {
                const ch = ctrl.channel as RTCDataChannel | undefined;
                if (ch) {
                  try {
                    ch.onmessage = null;
                    ch.onbufferedamountlow = null;
                    ch.onerror = null;
                    ch.onclose = null;
                    if (ch.readyState === 'open' || ch.readyState === 'connecting') {
                      ch.close();
                    }
                  } catch {}
                }
                try {
                  rmCtrl?.(task.id);
                } catch {}
              }
              fileTransferList.removeRow(task.id);
            }
          });

          // Add paused tasks for orphan .ftcache files that have no matching task row
          const FTCACHE_SUFFIX = '.ftcache';
          const ftcacheFiles = (result as Row[]).filter(
            file => typeof file.name === 'string' && file.name.endsWith(FTCACHE_SUFFIX)
          );
          ftcacheFiles.forEach(file => {
            const baseName = file.name.slice(0, -FTCACHE_SUFFIX.length);
            if (validIds.has(baseName)) return;

            const rowId = createRow({
              id: baseName,
              path,
              name: baseName,
              totalBytes: 0,
              source: 'virtual-usb',
              direction: 'upload',
            });
            setState(rowId, 'paused');
            updateProgress(rowId, {
              transferredBytes: file.size,
              totalBytes: 0,
              progress: 0,
              transferredFormatted: humanSize(file.size),
              progressFormatted: '0%',
            });
          });
        }
      } finally {
        stopLoading('ftListFile');
      }
    },
    [
      sendAsync,
      wrap,
      setCurrentPath,
      setCompletedList,
      setSelectedCompletedRowKeys,
      startLoading,
      stopLoading,
    ]
  );

  const syncGetFileTransferState = useCallback(
    async (force: boolean = false) => {
      if (!isConnected && !force) return;
      const result = await wrap(
        'syncFetFileTransferState',
        sendAsync(
          {
            method: 'getFileTransferState',
          },
          {
            resultOnly: true,
          }
        )
      );

      setFileTransferState(result?.target as VMState);

      if (force) {
        if (result?.target === 'None') {
          handleMountWithFileImg('Kvm');
        } else if (result?.target === 'Kvm') {
          getFtFileSystemInfo();
          getFtStorageDetails();
          getCompletedList();
        }
      }
    },
    [
      sendAsync,
      isConnected,
      currentPath,
      wrap,
      getCompletedList,
      getFtFileSystemInfo,
      getFtStorageDetails,
    ]
  );

  // Mount media
  const handleMountWithFileImg = useCallback(
    async (target: 'Kvm' | 'RemoteUsb') => {
      startLoading('mountWithFileImg');

      if (fileTransferState !== 'None') {
        await sendAsync(
          {
            method: 'unmountWithFileImg',
            onResponse: () => {},
            onError: () => {},
          },
          {
            resultOnly: true,
          }
        );
      }

      send({
        method: 'mountWithFileImg',
        params: {
          target,
        },
        errorMessage: { prefix: 'Failed to mount image:' },
        successMessage: { prefix: 'Mounted successfully' },
        onResponse() {
          if (target === 'Kvm') {
            getFtFileSystemInfo();
            getFtStorageDetails();
            getCompletedList();
          }
          syncGetFileTransferState();
          stopLoading('mountWithFileImg');
        },
        onError() {
          stopLoading('mountWithFileImg');
        },
      });
    },
    [
      send,
      startLoading,
      stopLoading,
      syncGetFileTransferState,
      fileTransferState,
      getFtFileSystemInfo,
      getFtStorageDetails,
    ]
  );

  // Delete files/dirs
  const handleDelete = useCallback(async () => {
    if (hasFtcacheUploadingConflict) return;

    const targets = selectedCompletedRows;
    const delFiles = targets.filter(item => !item.is_dir);
    const delDir = targets.filter(item => item.is_dir);

    startLoading('ftDelFile');
    startLoading('ftDelDir');
    const tasks = delFiles.map(t =>
      sendAsync({
        method: 'ftDelFile',
        params: { path: joinPath(`${currentPath}/${t.name}`) },
      })
        .then(() => ({ name: t.name, ok: true }) as DeleteResult)
        .catch(err => ({ name: t.name, ok: false, error: err }) as DeleteResult)
    );
    const delDirTasks = delDir.map(t =>
      sendAsync({
        method: 'ftDelDir',
        params: { path: joinPath(`${currentPath}/${t.name}`) },
      })
        .then(() => ({ name: t.name, ok: true }) as DeleteResult)
        .catch(err => ({ name: t.name, ok: false, error: err }) as DeleteResult)
    );

    // Wait for all to settle (both success and failure return)
    await Promise.all([...tasks, ...delDirTasks]);
    stopLoading('ftDelFile');
    stopLoading('ftDelDir');
    getCompletedList(currentPath);
    getFtFileSystemInfo();
    getFtStorageDetails();
  }, [
    selectedCompletedRows,
    hasFtcacheUploadingConflict,
    currentPath,
    sendAsync,
    startLoading,
    stopLoading,
    getCompletedList,
    getFtFileSystemInfo,
    getFtStorageDetails,
  ]);

  const handleDeleteAllFiles = useCallback(async () => {
    if (isLoading('deleteAllFiles')) return;
    startLoading('deleteAllFiles');
    const { success, error } = await sendAsync(
      { method: 'clearFtUserFiles' },
      { showUnhandledErrorToast: false }
    );
    stopLoading('deleteAllFiles');
    if (!success) {
      toast.error(t('toolbar.virtualUsbDrive.storageDetails.filesDeleteFailed'));
      throw new Error(error.message);
    }
    await Promise.all([getCompletedList('/'), getFtFileSystemInfo(), getFtStorageDetails()]);
    toast.success(t('toolbar.virtualUsbDrive.storageDetails.filesDeleted'));
  }, [
    sendAsync,
    getCompletedList,
    getFtFileSystemInfo,
    getFtStorageDetails,
    isLoading,
    startLoading,
    stopLoading,
    t,
  ]);

  // Download selected files
  const handleDownload = useCallback(() => {
    if (hasFtcacheUploadingConflict) return;

    const targets = selectedCompletedRows.map(item => {
      return { name: item.name, path: currentPath, totalBytes: item.size };
    });

    downloadFile(targets);
    setListType('transfer');
    setTransferType('download');
    // Insert placeholder data in download list first, wait for onDownload/onProgress to update
    const seedItems: DownloadItem[] = targets.map(t => ({
      id: generateTaskId(t.name, t.path),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      path: t.path,
      name: t.name,
      totalBytes: t.totalBytes,
      transferredBytes: 0,
      progress: 0,
      state: 'pending',
      speedBps: 0,
      totalFormatted: '',
      transferredFormatted: '0',
      progressFormatted: '0%',
      speedFormatted: '0B/s',
      dataChannel: null,
      errorMessage: '',
    }));
    setDownloadFileList(seedItems);
  }, [selectedCompletedRows, hasFtcacheUploadingConflict, currentPath, setDownloadFileList]);

  // Create directory
  const handleCreateDir = useCallback(() => {
    confirm({
      title: t('toolbar.virtualUsbDrive.createDirDialog.title'),
      content: (
        <Input
          size="lg"
          ref={inputRef}
          autoFocus
          allowChinese
          placeholder={t('toolbar.virtualUsbDrive.createDirDialog.placeholder')}
        />
      ),
      confirmText: t('toolbar.virtualUsbDrive.createDirDialog.confirm'),
      cancelText: t('toolbar.virtualUsbDrive.createDirDialog.cancel'),
      onConfirm: async () => {
        const createDirName = inputRef.current?.value?.trim() || '';

        startLoading('ftCreateDir');
        send({
          method: 'ftCreateDir',
          params: {
            path: `${currentPath}/${createDirName}`.replace(/\/+/g, '/'),
          },
          onResponse() {
            getCompletedList(currentPath);

            stopLoading('ftCreateDir');
          },
          onError() {
            stopLoading('ftCreateDir');
          },
        });
      },
    });
  }, [inputRef, confirm, currentPath, sendAsync]);

  const handleCreateFile = useCallback(
    path => {
      send({
        method: 'ftCreateFile',
        params: {
          path: path.replace(/\/+/g, '/'),
        },
        onResponse() {
          getCompletedList(currentPath);
          // stopLoading('ftCreateDir');
        },
        onError() {
          // stopLoading('ftCreateDir');
        },
      });
    },
    [inputRef, confirm, currentPath, sendAsync]
  );

  const startParamsFn = (file: File) => {
    return {
      path: currentPathRef.current.replace(/\/{2,}/g, '/').replace(/([^:])\/$/, '$1'),
      name: file.name,
      size: file.size,
    };
  };

  // Open file
  const handleOpenFile = useCallback((_path: string) => {}, [send]);

  // Connection state effect
  useEffect(() => {
    logger.info('useEffect isConnected', isConnected);
    if (isConnected) {
      syncGetFileTransferState(true);
      useAppStore.getState().fileTransferList.hydrate();
      useAppStore.getState().fileTransferList.updateProgress();

      // Reconcile controller state with task list:
      // If a controller still has an open DataChannel, restore that task to 'running'.
      // If the channel is dead, clean up the stale controller.
      const { fileTransferList, controllers, removeUploadController } = useAppStore.getState();
      if (controllers) {
        Object.entries(controllers).forEach(([key, ctrl]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const channel: RTCDataChannel | null | undefined = (ctrl as any)?.channel;
          if (channel && channel.readyState === 'open') {
            // Channel is still alive — find matching task and set to running
            const task = Object.values(fileTransferList.byId).find(
              r => r.name === key || r.id === key
            );
            if (task) {
              fileTransferList.setState(task.id, 'running');
            }
          } else {
            // Channel is dead — clean up stale controller
            removeUploadController?.(key);
          }
        });
      }
      return;
    } else {
      // When connection is lost, change all running tasks to paused
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
          fileDownloadList.setState(download.id, 'paused');
        }
      });
    }
  }, [isConnected, sendAsync]);

  // Start upload
  const onStartUpload = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (payload: { filename: string; size: number; dataChannel: any }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { filename, size, dataChannel } = payload || ({} as any);

      createRow({
        path: currentPath || '/',
        name: filename,
        totalBytes: size,
        dataChannel: dataChannel?.label || dataChannel, // WebRTC channel name
        source: 'virtual-usb',
      });
    },
    [createRow, currentPath, uploads, uploadMap]
  );

  // Optional: also handle onProgress to update offset and speed (more complete)
  const onProgressUpload = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (data: any) => {
      //id: string, offset: number, speedBps?: number

      const { name } = data;
      if (!name) return;

      updateProgress(name, data);
    },
    [updateProgress]
  );

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const scheduleRefreshAfterUploadSuccess = useCallback(() => {
    clearRefreshTimer();
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      getCompletedList(currentPathRef.current);
      getFtFileSystemInfo();
      getFtStorageDetails();
    }, 3000);
  }, [clearRefreshTimer, getCompletedList, getFtFileSystemInfo, getFtStorageDetails]);

  useEffect(() => {
    return () => {
      clearRefreshTimer();
    };
  }, [clearRefreshTimer]);

  const onSuccessUpload = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (file: any) => {
      const name = file?.name;
      removeRow(name);
      try {
        deleteUploadTask(name);
      } catch {}
      scheduleRefreshAfterUploadSuccess();
    },
    [removeRow, scheduleRefreshAfterUploadSuccess]
  );

  const handleBreadcrumbClick = useCallback((path: string) => {
    getCompletedList(path);
  }, []);

  const handleCancelDownload = useCallback(
    (taskId: string) => {
      downloadFileCancel(taskId);
      removeDownloadRow(taskId);
    },
    [downloadFileCancel, removeDownloadRow]
  );

  const onResumeStart = useCallback(
    (payload: { filename: string; taskId?: string }) => {
      const { taskId } = payload || {};
      if (!taskId) return;
      try {
        setState(taskId, 'running');
      } catch (e) {
        logger.error('Failed to mark upload row as running on resume', e);
      }
    },
    [setState]
  );

  const handleResumeUpload = useCallback(
    async (row: TransferRow) => {
      const taskPath = row.path || '/';
      currentPathRef.current = taskPath;
      setCurrentPath(taskPath);
      // Stay on the current task list view; do not jump back to the file list.
      void getCompletedList(taskPath);

      // 1) Prefer an in-session upload controller (pause/continue in same tab).
      const ctrl = getUploadController?.(row.name) || getUploadController?.(row.id);
      if (ctrl && typeof ctrl.resume === 'function') {
        try {
          ctrl.resume();
          setState(row.id, 'running');
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
        // 3) If the persisted task/handle is missing or FSA is unavailable,
        //    open the native file picker so the user can re-select the same file.
        //    The device still returns alreadyUploadedBytes by filename, so the
        //    upload continues from the server-side offset.
        const recoverableCodes = new Set<UploadResumeErrorCode>([
          'file-missing',
          'not-supported',
          'permission-denied',
        ]);
        const isRecoverable = err instanceof UploadResumeError && recoverableCodes.has(err.code);

        if (isRecoverable) {
          toast.info(
            t('toolbar.virtualUsbDrive.resumeFallback', {
              defaultValue: 'Please re-select the file to continue the upload',
            })
          );
          uploadDropZoneRef.current?.openFilePicker();
          return;
        }
        toast.error(message || 'Resume upload failed');
        try {
          setState(row.id, 'failed', message);
        } catch {}
      }
    },
    [getCompletedList, getUploadController, setState, t]
  );

  return {
    // State
    uploads,
    downloads,
    fileTransferState,
    currentPath,
    listType,
    setListType,
    completedList,
    showCompletedList,
    transferType,
    setTransferType,
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
    inputRef,

    // Callbacks
    handlePauseUpload,
    handleRemoveUpload,
    handleDelete,
    handleDeleteAllFiles,
    handleDownload,
    handleCancelDownload,
    handleCreateDir,
    handleCreateFile,
    handleMountWithFileImg,
    handleBreadcrumbClick,
    handleOpenFile,
    getCompletedList,
    getFtFileSystemInfo,
    getFtStorageDetails,
    syncGetFileTransferState,
    startParamsFn,
    onStartUpload,
    onProgressUpload,
    onSuccessUpload,
    setState,
    truncateBytes,

    // Refs
    currentPathRef,
    uploadDropZoneRef,

    // Resume callbacks
    onResumeStart,
    handleResumeUpload,

    // Logger
    logger,
  };
}

export type UseVirtualUsbDriveReturn = ReturnType<typeof useVirtualUsbDrive>;
