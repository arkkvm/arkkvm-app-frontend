// @no-export
import { createLogger } from '@/utils/logger';
import { useEffect, useRef, useState } from 'react';
import type { JsonRpcSendAsync } from '@/api/rpc/types';
import { env } from '@/utils/env';
import { useAppStore } from '@/stores';

const logger = createLogger('ControlLease');

export type ControlPrompt = { kind: 'agent' } | { kind: 'request'; requestId: string };
export type ControlAction = 'takeOverControl' | 'grantControl' | 'denyControl';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

// Web presentation state only. Device notifications remain the source of authority.
export function useControlLease(channel: RTCDataChannel | null | undefined) {
  const [prompt, setPrompt] = useState<ControlPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'failed' | 'stale' | null>(null);
  const revision = useRef(0);
  const inFlight = useRef(false);
  const preview = useRef(false);
  const dismissTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  function clearDismissTimer() {
    if (dismissTimer.current === null) return;
    window.clearTimeout(dismissTimer.current);
    dismissTimer.current = null;
  }

  function reset() {
    clearDismissTimer();
    revision.current += 1;
    inFlight.current = false;
    preview.current = false;
    setPrompt(null);
    setBusy(false);
    setError(null);
  }

  useEffect(() => {
    if (prompt?.kind !== 'agent') return;
    // Dismiss the informational prompt only; never change device control on a UI timer.
    dismissTimer.current = window.setTimeout(reset, 120000);
    return clearDismissTimer;
  }, [prompt]);

  useEffect(() => {
    reset();
    useAppStore.getState().setAgentControlOwner(undefined);
    function onClose() {
      reset();
      useAppStore.getState().setAgentControlOwner(undefined);
    }
    function previewConflict() {
      onNotification('controlConflict', {
        owner: 'user',
        pending: {
          requestId: 'preview-human-to-agent',
          requester: 'agent',
          reason: 'humanHasControl',
          deadlineMs: 120000,
          timeoutPolicy: 'grantRequester',
        },
      }, true);
      preview.current = true;
      logger.debug('[控制权模拟] 情境三：Human 持控，Agent 申请控制；按钮不会发送真实 RPC。');
    }
    if (env.isDev) window.addEventListener('arkkvm:preview-control-conflict', previewConflict);
    channel?.addEventListener('close', onClose);
    return () => {
      window.removeEventListener('arkkvm:preview-control-conflict', previewConflict);
      channel?.removeEventListener('close', onClose);
      useAppStore.getState().setAgentControlOwner(undefined);
      revision.current += 1;
      inFlight.current = false;
    };
  }, [channel]);

  function onNotification(method: string, params: unknown, isPreview = false) {
    if (method !== 'controlChanged' && method !== 'controlConflict') return false;
    if (!record(params) || (params.owner !== 'user' && params.owner !== 'agent' && params.owner !== null)) return true;
    const pending = record(params.pending) ? params.pending : null;
    const isAgentRequest = method === 'controlConflict' && params.owner === 'user' &&
      pending?.requester === 'agent' && pending.reason === 'humanHasControl' &&
      typeof pending.requestId === 'string' && pending.requestId.trim().length > 0;
    if (method === 'controlConflict' && params.owner !== 'agent' && !isAgentRequest) return true;
    if (!isPreview) useAppStore.getState().setAgentControlOwner(
      params.owner, typeof params.reason === 'string' ? params.reason : undefined
    );
    logger.debug(method === 'controlChanged' ? '[控制权] 收到控制权变更通知' : '[控制权] 收到控制冲突通知', {
      owner: params.owner,
      reason: typeof params.reason === 'string' ? params.reason : pending?.reason,
      requestId: isAgentRequest ? pending?.requestId : undefined,
    });
    reset();
    if (isAgentRequest && pending && typeof pending.requestId === 'string') {
      setPrompt({ kind: 'request', requestId: pending.requestId });
    } else if (params.owner === 'agent' &&
      !(method === 'controlChanged' && params.reason === 'timeoutGranted')) {
      setPrompt({ kind: 'agent' });
    }
    return true;
  }

  async function act(action: ControlAction, sendAsync: JsonRpcSendAsync) {
    if (!prompt || inFlight.current) return;
    if (action !== 'takeOverControl' && prompt.kind !== 'request') return;
    if (env.isDev && preview.current) {
      logger.debug('[控制权模拟] 已选择：', action === 'denyControl' ? '保留控制' : '交出控制 / 仅观看', '（未发送 RPC）');
      reset();
      return;
    }
    if (channel?.readyState !== 'open') return;
    clearDismissTimer();
    const currentRevision = revision.current;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const response = await sendAsync(action === 'takeOverControl'
      ? { method: action }
      : { method: action, params: { requestId: prompt.kind === 'request' ? prompt.requestId : '' } });
    if (revision.current !== currentRevision) return;
    inFlight.current = false;
    setBusy(false);
    if (!response.success) {
      const data = response.error.data;
      setError(record(data) && data.code === 'controlStale' ? 'stale' : 'failed');
      return;
    }
    // The successful response acknowledges this choice; later notifications may open a new prompt.
    useAppStore.getState().setAgentControlOwner(
      response.result.owner, action === 'takeOverControl' ? 'takeOver' : undefined
    );
    reset();
  }

  return { prompt, busy, error, reset, onNotification, act };
}
