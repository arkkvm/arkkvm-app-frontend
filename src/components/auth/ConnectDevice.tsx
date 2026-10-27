// @no-export
import { WelcomeBackground } from '@/components';
import TopNavbar from '@/components/TopNavbar/TopNavbar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import type { UserInfo } from '@/stores/slices/userSlice';
import { CheckCircle2, ChevronDown, Pencil } from 'lucide-react';
import type { readDeviceBindingConflict } from '@/api/deviceBinding';
import DeviceConnectionFailure from './DeviceConnectionFailure';
import { StatusPalette } from '@/ui/statusColors';
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

interface ConnectDeviceProps {
  deviceId: string;
  name: string;
  systemVersion: string;
  account: Pick<UserInfo, 'email' | 'displayName' | 'identities'> | null;
  loading: boolean;
  submitting: boolean;
  switching?: boolean;
  error: string;
  bindingConflict?: ReturnType<typeof readDeviceBindingConflict>;
  blocked?: boolean;
  stage: 'loading' | 'confirm' | 'complete' | 'success' | 'failure';
  onDashboard?: () => void;
  onRetry: () => void;
  onConnect: () => void;
  onSaveName: (name: string) => Promise<boolean>;
  onSwitchAccount?: () => void;
  onBack?: () => void;
}

export default function ConnectDevice(props: ConnectDeviceProps) {
  const { t } = useTranslation('common');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.name);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState('');
  const accountLabel =
    props.account?.displayName?.trim() ||
    props.account?.identities?.find(identity => identity.displayName?.trim())?.displayName?.trim() ||
    props.account?.email?.trim() ||
    props.account?.identities?.find(identity => identity.email?.trim())?.email?.trim() ||
    '';
  const providers = [...new Set(props.account?.identities?.map(identity => identity.provider).filter(Boolean))]
    .map(provider => t(`deviceConnect.providers.${provider}`, { defaultValue: provider }))
    .join(' / ');
  const accountWithProviders = providers
    ? t('deviceConnect.accountWithProviders', { account: accountLabel, providers })
    : accountLabel;
  useEffect(() => {
    setDraft(props.name);
  }, [props.name]);
  const busy = props.loading || props.submitting || props.switching || saving;
  const save = async () => {
    if (saving) return;
    const name = draft.trim();
    if (!name) {
      setNameError('required');
      return;
    }
    if (!/^[\s\S]{3,20}$/u.test(name)) {
      setNameError('nameLength');
      return;
    }
    setSaving(true);
    setNameError('');
    try {
      if (await props.onSaveName(name)) setEditing(false);
      else setNameError('editError');
    } catch {
      setNameError('editError');
    } finally {
      setSaving(false);
    }
  };
  const row = (label: string, value: string) => (
    <div className="grid grid-cols-3 items-center gap-3 px-3 py-2">
      <dt className="text-base text-muted-foreground">{label}</dt>
      <dd className="col-span-2 flex min-w-0 items-center justify-between gap-2 text-left text-base text-text">
        <span translate={value ? 'no' : undefined} className={value ? 'break-all notranslate' : 'break-all'}>{value || t('deviceConnect.unavailable')}</span>
        {value && <CopyButton text={value} label={label} />}
      </dd>
    </div>
  );
  return (
    <div className="dark flex min-h-dvh flex-col text-text">
      <TopNavbar
        showLinks={false}
        showLoggedIn={Boolean(props.account)}
        account={props.account}
        onLogout={props.onSwitchAccount}
      />
      <WelcomeBackground
        showLogo={false}
        minHeight="min-h-0"
        className="min-h-0! flex-1 bg-(--bg-primary)"
      >
        <div className="grid min-h-[calc(100dvh-52px)] w-full max-w-3xl items-center py-8 sm:min-h-[calc(100dvh-60px)] sm:pb-24">
          <main className="mx-auto w-full text-center text-base">
            {props.stage === 'failure' ? (
              <DeviceConnectionFailure
                deviceId={props.deviceId}
                message={props.error}
                conflict={props.bindingConflict}
                busy={Boolean(busy)}
                onRetry={props.onRetry}
              />
            ) : (
              <>
                {props.stage === 'success' && (
                  <CheckCircle2 aria-hidden="true" className={`mx-auto mb-5 size-9 ${StatusPalette.ok}`} />
                )}
            <h1 className="text-4xl font-bold leading-tight text-text">
              {t(
                props.stage === 'confirm' || props.stage === 'loading'
                  ? 'deviceConnect.title'
                  : props.stage === 'success'
                    ? 'deviceConnect.successTitle'
                    : 'deviceConnect.setupTitle'
              )}
            </h1>
            {(props.stage === 'confirm' || props.stage === 'success') && props.account && (
              <p className="mt-2 break-words text-lg leading-6 text-muted-foreground">
                {props.stage === 'success' ? (
                  t('deviceConnect.successDescription', { email: accountWithProviders })
                ) : (
                  <Trans
                    ns="common"
                    i18nKey="deviceConnect.description"
                    values={{ email: accountWithProviders }}
                    components={{ account: <span className="text-(--btn-primary-bg)" /> }}
                  />
                )}
              </p>
            )}
            {(props.loading || (props.stage === 'complete' && !props.error)) && (
              <p role="status" className="mt-5 text-base text-muted-foreground">
                {t(
                  props.stage === 'complete' ? 'deviceConnect.finishing' : 'deviceConnect.loading'
                )}
              </p>
            )}
            {props.stage === 'confirm' && (
              <>
                {props.stage === 'confirm' && (
                  <Button
                    variant="primary"
                    className="mt-10 min-w-32 text-lg"
                    loading={props.submitting}
                    disabled={
                      busy || editing || props.blocked || !props.account || !props.name.trim()
                    }
                    onClick={props.onConnect}
                  >
                    {t(props.submitting ? 'deviceConnect.connecting' : 'deviceConnect.connect')}
                  </Button>
                )}
                <section className="mx-auto mt-14 w-full max-w-md text-left" aria-labelledby="connect-device-information">
                  <h2
                    id="connect-device-information"
                    className="mb-3 flex items-center justify-center gap-1 text-base font-medium text-muted-foreground"
                  >
                    <ChevronDown aria-hidden="true" className="size-3" />
                    {t('deviceConnect.information')}
                  </h2>
                  <Card className="overflow-hidden rounded-md border-border bg-(--bg-secondary) p-0 shadow-none backdrop-blur-none dark:border-border dark:bg-(--bg-secondary)">
                    <dl className="divide-y divide-border">
                      {row(t('deviceConnect.serial'), props.deviceId)}
                      <div className="grid grid-cols-3 items-center gap-3 px-3 py-2">
                        <dt className="text-base text-muted-foreground">{t('deviceConnect.name')}</dt>
                        <dd className="col-span-2 min-w-0 text-left text-base text-text">
                          {editing ? (
                            <div className="space-y-2">
                              <Input
                                autoFocus
                                className="text-base md:text-base"
                                aria-label={t('deviceConnect.name')}
                                value={draft}
                                allowChinese
                                onChange={event => {
                                  setDraft(event.target.value);
                                  setNameError('');
                                }}
                                disabled={busy}
                              />
                              <p className="text-base leading-6 text-muted-foreground">
                                {t('deviceConnect.draftHint')}
                              </p>
                              {nameError && (
                                <p role="alert" className="text-destructive">
                                  {t(`deviceConnect.${nameError}`)}
                                </p>
                              )}
                              <div className="flex justify-end gap-2">
                                <Button
                                  size="sm"
                                  className="text-base"
                                  disabled={busy}
                                  onClick={() => {
                                    setDraft(props.name);
                                    setNameError('');
                                    setEditing(false);
                                  }}
                                >
                                  {t('deviceConnect.cancel')}
                                </Button>
                                <Button
                                  size="sm"
                                  className="text-base"
                                  variant="primary"
                                  loading={saving}
                                  disabled={busy}
                                  onClick={() => void save()}
                                >
                                  {t('deviceConnect.save')}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center justify-between gap-2">
                              <span className="break-all">
                                {props.name || t('deviceConnect.unavailable')}
                              </span>
                              <Button
                                size="xs"
                                variant="ghost"
                                aria-label={t('deviceConnect.edit')}
                                disabled={busy || props.blocked || props.stage === 'failure'}
                                onClick={() => {
                                  setDraft(props.name);
                                  setEditing(true);
                                }}
                              >
                                <Pencil className="size-4" />
                              </Button>
                            </div>
                          )}
                        </dd>
                      </div>
                      {row(t('deviceConnect.version'), props.systemVersion)}
                    </dl>
                  </Card>
                </section>
              </>
            )}
            {props.stage === 'success' && (
              <div className="mt-6 space-y-4 text-base leading-6 text-muted-foreground">
                <p>{t('deviceConnect.redirectingDashboard')}</p>
                {props.onDashboard && (
                  <Button variant="link" className="text-base" onClick={props.onDashboard} disabled={busy}>
                    {t('deviceConnect.dashboard')}
                  </Button>
                )}
                <p>{t('deviceConnect.dashboardHint')}</p>
              </div>
            )}
              </>
            )}
            {props.onSwitchAccount && (props.stage === 'confirm' || props.stage === 'failure') && (
              <div className="mt-12 text-base text-muted-foreground">
                <p className="font-semibold">{t('deviceConnect.notRight')}</p>
                <Button
                  variant="link"
                  className="max-w-full whitespace-normal text-base underline"
                  disabled={busy}
                  onClick={props.onSwitchAccount}
                >
                  {t(props.switching ? 'deviceConnect.switching' : 'deviceConnect.switch')}
                </Button>
              </div>
            )}
            {props.onBack && props.error && (
              <Button variant="ghost" className="mt-4" disabled={busy} onClick={props.onBack}>
                {t('deviceConnect.back')}
              </Button>
            )}
          </main>
        </div>
      </WelcomeBackground>
    </div>
  );
}
