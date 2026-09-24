import { useState } from 'react';
import type { RunnerStatusSummary, RuntimeStatus, Settings, Workspace } from '../../domain/models';
import { sendRuntime } from '../services/runtime-client';
import { getUserFacingMessage } from '../services/error-messages';
import { useI18n } from '../../i18n';

/**
 * Local Runner settings card.
 *
 * Surfaces the execution engine selection, runner health (version/protocol/
 * account/profile), connection test, login setup, and the workspace-bound
 * expected account. All strings are i18n keys (AR/EN) — no hardcoded text.
 * Runner failure states stay DISTINCT (not installed / launch failed /
 * protocol mismatch / disconnected) and map to actionable messages.
 */

interface LocalRunnerCardProps {
  settings: Settings;
  onSettingsChange: (settings: Settings) => void;
  runtimeStatus: RuntimeStatus | null;
  activeWorkspace: Workspace | undefined;
  onWorkspacePatch: (patch: Partial<Pick<Workspace, 'expectedAccount'>>) => void;
  onNotice: (message: string) => void;
}

export function LocalRunnerCard({ settings, onSettingsChange, runtimeStatus, activeWorkspace, onWorkspacePatch, onNotice }: LocalRunnerCardProps) {
  const { t } = useI18n();
  const [runnerTested, setRunnerTested] = useState<{ ok: boolean; message: string } | null>(null);
  const [expectedAccountDraft, setExpectedAccountDraft] = useState(activeWorkspace?.expectedAccount ?? '');
  const [loginSetupBusy, setLoginSetupBusy] = useState(false);
  const runner: RunnerStatusSummary | undefined = runtimeStatus?.runner;
  const runnerState = runner?.state ?? 'UNKNOWN';
  const detectedAccount = runner?.detectedAccount;
  const expected = activeWorkspace?.expectedAccount;
  const accountMismatch = Boolean(expected && detectedAccount && detectedAccount !== expected);

  const testConnection = async () => {
    const result = await sendRuntime({ type: 'RUNNER_TEST', workspaceId: activeWorkspace?.id });
    if (result?.error) {
      setRunnerTested({ ok: false, message: getUserFacingMessage(result.error) });
      onNotice(getUserFacingMessage(result.error));
      return;
    }
    if (result?.ok) {
      setRunnerTested({ ok: true, message: t('runner.connected') });
      onNotice(t('runner.connected'));
    } else {
      const message = result?.code ? getUserFacingMessage(result.code) : (result?.message ?? t('errors.unknown'));
      setRunnerTested({ ok: false, message });
      onNotice(message);
    }
  };

  const setupLogin = async () => {
    if (!window.confirm(t('runner.setupLoginConfirm'))) return;
    setLoginSetupBusy(true);
    try {
      const result = await sendRuntime({ type: 'RUNNER_SETUP_LOGIN', workspaceId: activeWorkspace?.id }) as { error?: string } | undefined;
      if (result?.error) { onNotice(getUserFacingMessage(result.error)); return; }
      onNotice(t('runner.loginWindowOpened'));
    } finally {
      setLoginSetupBusy(false);
    }
  };

  const closeLoginWindow = async () => {
    const result = await sendRuntime({ type: 'RUNNER_CANCEL_LOGIN', workspaceId: activeWorkspace?.id });
    if (result?.error) onNotice(getUserFacingMessage(result.error));
    else onNotice(t('runner.loginWindowClosed'));
  };

  const saveExpectedAccount = () => {
    onWorkspacePatch({ expectedAccount: expectedAccountDraft.trim() ? expectedAccountDraft.trim() : undefined });
    onNotice(t('runner.expectedAccountSaved'));
  };

  const engine = settings.executionBackend ?? 'CHROME_TAB';
  const sessionEngine = runtimeStatus?.sessionExecutionBackend;
  const pinnedEngineActive = Boolean(sessionEngine && sessionEngine !== engine);

  return (
    <section className="runner-actions" aria-label={t('runner.title')}>
      <h3>{t('runner.title')}</h3>
      <label>{t('runner.engine')}
        <select value={engine} onChange={(event) => onSettingsChange({ ...settings, executionBackend: event.target.value as Settings['executionBackend'] })}>
          <option value="CHROME_TAB">{t('runner.engineChromeTab')}</option>
          <option value="LOCAL_RUNNER">{t('runner.engineLocalRunner')}</option>
        </select>
      </label>
      <p className="muted">{t('runner.engineHint')}{pinnedEngineActive ? ` · ${sessionEngine === 'LOCAL_RUNNER' ? t('runner.engineLocalRunner') : t('runner.engineChromeTab')}` : ''}</p>
      <div className="row controls-row">
        <span className={`runner-state runner-state-${runnerState.toLowerCase()}`}>{t(`runner.states.${runnerState}`)}</span>
        {runner?.runnerVersion ? <span className="muted" dir="ltr">{t('runner.version')}: v{runner.runnerVersion}</span> : null}
        {runner?.protocolVersion ? <span className="muted" dir="ltr">{t('runner.protocol')}: v{runner.protocolVersion}{runner.protocolCompatible === false ? ' ⚠' : ''}</span> : null}
      </div>
      <div className="row controls-row">
        <span className="muted" dir="ltr">{t('runner.profile')}: {activeWorkspace ? activeWorkspace.id.slice(0, 8) : '—'}</span>
        <span className="muted" dir="ltr">{t('runner.account')}: {detectedAccount ? `@${detectedAccount}` : '—'}</span>
        {accountMismatch ? <span className="runner-account-mismatch">{t('errors.runnerAccountMismatch')}</span> : null}
      </div>
      <div className="row controls-row">
        <button onClick={() => void testConnection()}>{t('runner.testConnection')}</button>
        <button disabled={loginSetupBusy} onClick={() => void setupLogin()}>{t('runner.setupLogin')}</button>
        <button onClick={() => void closeLoginWindow()}>{t('runner.cancelLogin')}</button>
      </div>
      {runnerState === 'NOT_INSTALLED' ? <p className="muted">{t('runner.errorHint')}</p> : null}
      {runnerTested && !runnerTested.ok ? <p className="error-inline" role="alert">{runnerTested.message}</p> : null}
      <label>{t('runner.expectedAccount')}
        <input value={expectedAccountDraft} onChange={(event) => setExpectedAccountDraft(event.target.value)} placeholder="handle" dir="ltr" />
      </label>
      <p className="muted">{t('runner.expectedAccountHint')}</p>
      <div className="row controls-row">
        <button onClick={saveExpectedAccount}>{t('actions.save')}</button>
      </div>
    </section>
  );
}
