/**
 * AuthLayout - Cloud Login Layout
 * Visual style aligned with device local login page
 */
import { WelcomeBackground } from '@/components';
import { Button } from '@/components/ui/button';
import { normalizeCloudOrigin, normalizeDeviceId } from '@/utils/security';
import { env } from '@/utils/env';
import React, { useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export interface LoginOption {
  /** Button label (already i18n-resolved by the page). */
  label: string
  icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>
  /** Form action: POST {cloudApi}/oidc/{provider}. */
  actionUrl: string
}

export interface AuthLayoutProps {
  title: string
  description?: string
  action: string
  footerText?: string
  leadingIcon?: React.ComponentType<React.SVGProps<SVGSVGElement>>
  actionUrl?: string
  onSubmit?: React.FormEventHandler<HTMLFormElement>
  /** Multiple login providers (doc 14 §4); replaces the single button when set. */
  loginOptions?: LoginOption[]
  /** Replace sign-in controls when this login flow is unavailable. */
  unavailableMessage?: string
  /** Provider list still loading: render placeholders, not a partial list. */
  optionsPending?: boolean
  /** Placeholder rows to reserve while pending. */
  skeletonCount?: number
}

const buttonClass =
  'w-full h-[48px] bg-(--btn-outline-bg) hover:bg-(--btn-outline-bg-hover) text-(--btn-outline-text) font-medium text-[15px] rounded-[12px] border border-(--btn-outline-border) shadow-lg shadow-(--bg-primary)/15 transition-all duration-200 ease-out hover:shadow-xl hover:shadow-(--bg-primary)/25 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3';

export default function AuthLayout({
  title,
  description,
  action,
  footerText,
  leadingIcon: LeadingIcon,
  actionUrl,
  onSubmit,
  loginOptions,
  optionsPending,
  unavailableMessage,
  skeletonCount = 2,
}: AuthLayoutProps) {
  const [sq] = useSearchParams();
  const { t } = useTranslation('common');
  const location = useLocation();
  const [submitting, setSubmitting] = useState(false);

  const rawReturnTo = sq.get('returnTo');
  const safeReturnToOrigin = normalizeCloudOrigin(rawReturnTo ?? env.appBaseUrl);
  const rawDeviceId = sq.get('deviceId') ?? (location.state as Record<string, unknown> | null)?.deviceId;
  const deviceId = normalizeDeviceId(rawDeviceId);
  // Pairing always returns to Cloud for confirmation before visiting the device.
  const returnTo = env.target === 'cloud' && deviceId
    ? `${window.location.origin}/ad-login`
    : safeReturnToOrigin
    ? safeReturnToOrigin + '/ad-login'
    : null;
  const actionOrigin = normalizeCloudOrigin(actionUrl);
  const safeActionUrl = actionOrigin && actionUrl ? new URL(actionUrl.trim()).href : null;
  const hasOptions = Boolean(loginOptions && loginOptions.length > 0);
  const invalid =
    !returnTo || (rawDeviceId != null && !deviceId) || (!onSubmit && !safeActionUrl && !hasOptions);

  const loading = submitting;

  // MCP grant flow (cloud migration/15 §3): forward the client marker and
  // its req binding as hidden authorize fields. They cannot ride on returnTo
  // (it is rewritten to <origin>/ad-login above); only attached when both
  // are present, so every other page is untouched.
  const mcpClient = sq.get('client') === 'mcp' ? 'mcp' : '';
  const mcpReq = sq.get('req') ?? '';
  const mergedHidden: Record<string, string> = {
    ...(deviceId ? { deviceId } : {}),
    ...(returnTo ? { returnTo } : {}),
    ...(mcpClient && mcpReq ? { client: mcpClient, req: mcpReq } : {}),
  } as Record<string, string>;

  const renderOption = (option: LoginOption) => {
    // GET navigation instead of form POST: Chromium refuses cross-subdomain
    // POST under a form-action CSP. Authorize reads query and form alike,
    // so a GET with query params works identically.
    const optionUrl = normalizeCloudOrigin(option.actionUrl)
      ? new URL(option.actionUrl.trim()).href
      : null;
    const Icon = option.icon;
    const params = new URLSearchParams(mergedHidden);
    const href = optionUrl ? `${optionUrl}?${params}` : '#';
    return (
      <a key={option.actionUrl} href={href}
        className="no-underline w-full"
        onClick={e => {
          if (!optionUrl || href === '#') { e.preventDefault(); return; }
          setSubmitting(true);
        }}
      >
        <Button variant="outline" className={buttonClass} type="button" disabled={loading || !optionUrl}>
          {Icon ? <Icon className={`w-[26px] h-[26px] size-[30px] ${/\/oidc\/(github|apple|wechat)$/.test(option.actionUrl) ? '[&_path]:fill-current' : ''}`} /> : null}
          <span>{option.label}</span>
        </Button>
      </a>
    );
  };

  const renderSkeleton = (key: number) => (
    <div
      key={`skeleton-${key}`}
      aria-hidden="true"
      className="w-full h-[48px] rounded-[12px] border border-(--border-color)/20 bg-(--bg-secondary) shadow-lg shadow-(--bg-primary)/15 animate-pulse"
    />
  );

  return (
    <WelcomeBackground
      title={title}
      subtitle={description}
      className="bg-(--bg-primary) max-sm:min-h-0 max-sm:[&_h1]:mt-8 max-sm:[&_h1]:mb-3"
      minHeight="min-h-0 py-6 sm:min-h-screen sm:pt-0 sm:pb-16"
    >
      {/* Form area - centered, optimized width for visual presence */}
      <div className="mt-6 w-[360px] max-w-[calc(100vw-40px)] sm:mt-8">
        {unavailableMessage ? (
          <p role="status" className="text-center text-base leading-relaxed text-muted-foreground">
            {unavailableMessage}
          </p>
        ) : optionsPending ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: skeletonCount }, (_, i) => renderSkeleton(i))}
          </div>
        ) : hasOptions ? (
          <div className="flex flex-col gap-3">
            {loginOptions!.map(renderOption)}
          </div>
        ) : (
          <form
            action={safeActionUrl || undefined}
            method={actionUrl ? 'POST' : undefined}
            onSubmit={e => {
              if (invalid) { e.preventDefault(); return; }
              if (!actionUrl && onSubmit) onSubmit(e);
              setSubmitting(true);
            }}
            className="w-full"
          >
            {Object.entries(mergedHidden).map(([k, v]) =>
              v !== undefined ? (
                <input key={k} type="hidden" name={k} value={v} />
              ) : null,
            )}

            {/* Single login button - full width, aligned with device login style */}
            <Button variant="outline" className={buttonClass} type="submit" disabled={loading || invalid}>
              {LeadingIcon ? <LeadingIcon className="w-[26px] h-[26px] size-[30px]" /> : null}
              <span>{action}</span>
            </Button>
          </form>
        )}
        {!unavailableMessage && !optionsPending && invalid && <p role="alert">{t('adLoginError.description')}</p>}

        {/* Footer text - below button, weak hierarchy but clear */}
        {footerText ? (
          <div className="mt-5 flex items-center justify-center gap-2">
            <svg
              className="w-3.5 h-3.5 text-[var(--text-secondary)]/80"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <p className="text-[13px] text-[var(--text-secondary)]/90 tracking-wide">
              {footerText}
            </p>
          </div>
        ) : null}
      </div>
    </WelcomeBackground>
  );
}
