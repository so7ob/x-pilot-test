import { getLocale } from '../../i18n/index.ts';
import { translateForLocale } from '../../i18n/translate.ts';

export const errorTranslationKeys: Record<string, string> = {
  X_DAILY_POST_LIMIT_REACHED: 'errors.dailyPostLimitReached',
  LOGIN_REQUIRED: 'errors.loginRequired',
  PUBLISH_CONTROLS_NOT_READY: 'errors.publishControlsNotReady',
  INVALID_JSON: 'errors.invalidJson',
  BANK_IMPORT_INVALID: 'errors.bankImportInvalid',
  BANK_IMPORT_UNSUPPORTED_VERSION: 'errors.bankImportUnsupportedVersion',
  BANK_IMPORT_EMPTY: 'errors.bankImportEmpty',
  BANK_IMPORT_TOO_LARGE: 'errors.bankImportTooLarge',
  BANK_IMPORT_BANK_TOO_LARGE: 'errors.bankImportBankTooLarge',
  BANK_IMPORT_INVALID_URL: 'errors.bankImportInvalidUrl',
  BANK_IMPORT_INVALID_SNAPSHOT: 'errors.bankImportInvalidSnapshot',
  BANK_EXPORT_NOT_FOUND: 'errors.bankExportNotFound',
  // Local Runner failures — deliberately DISTINCT states, never collapsed
  // into a generic error (see the runner settings card for recovery actions).
  RUNNER_NOT_INSTALLED: 'errors.runnerNotInstalled',
  RUNNER_CONNECT_EXHAUSTED: 'errors.runnerNotInstalled',
  RUNNER_LAUNCH_FAILED: 'errors.runnerLaunchFailed',
  RUNNER_PROTOCOL_MISMATCH: 'errors.runnerProtocolMismatch',
  RUNNER_LOGIN_REQUIRED: 'errors.runnerLoginExpired',
  RUNNER_LOGIN_NOT_PERSISTED: 'errors.runnerLoginExpired',
  RUNNER_LOGIN_WINDOW_TIMEOUT: 'errors.runnerLoginExpired',
  RUNNER_PROFILE_LOCKED: 'errors.runnerProfileInUse',
  RUNNER_LOGIN_WINDOW_BUSY: 'errors.runnerProfileInUse',
  RUNNER_ACCOUNT_MISMATCH: 'errors.runnerAccountMismatch',
  RUNNER_ACCOUNT_UNKNOWN: 'errors.runnerAccountUnknown',
  RUNNER_DISCONNECTED: 'errors.runnerDisconnected',
  RUNNER_TIMEOUT: 'errors.runnerTimeout',
  RUNNER_CONTENT_MISMATCH: 'errors.runnerContentMismatch',
};

export function errorTranslationKey(message?: string): string | undefined {
  if (!message) return undefined;
  return Object.keys(errorTranslationKeys).find((code) => message.includes(code));
}

export function toUserFacingMessage(message?: string): string | undefined {
  if (!message) return message;
  const code = errorTranslationKey(message);
  return code ? message.replaceAll(code, translateForLocale(getLocale(), errorTranslationKeys[code])) : message;
}

export function getUserFacingMessage(message: string): string {
  return toUserFacingMessage(message) ?? message;
}
