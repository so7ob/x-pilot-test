import test from 'node:test';
import assert from 'node:assert/strict';
import { getUserFacingMessage, toUserFacingMessage } from '../src/ui/services/error-messages.ts';
import { setLanguagePreference } from '../src/i18n/index.ts';

test('translates the daily-limit code to the selected Arabic locale', async () => {
  await setLanguagePreference('AR');
  assert.equal(getUserFacingMessage('X_DAILY_POST_LIMIT_REACHED'), 'لقد وصلت إلى الحد الأقصى لعدد المنشورات اليومية');
  assert.equal(toUserFacingMessage('فشل: X_DAILY_POST_LIMIT_REACHED'), 'فشل: لقد وصلت إلى الحد الأقصى لعدد المنشورات اليومية');
});

test('translates known codes and preserves unrelated messages', async () => {
  await setLanguagePreference('EN');
  assert.equal(getUserFacingMessage('PUBLISH_CONTROLS_NOT_READY'), 'Publishing controls are not ready');
  assert.equal(toUserFacingMessage(undefined), undefined);
});

test('raw Chrome native-host disconnect messages localize for the user (issue #9)', async () => {
  await setLanguagePreference('EN');
  assert.equal(
    getUserFacingMessage('Error when communicating with the native messaging host.'),
    'The native messaging pipe to Local Runner broke. Run install\\doctor.ps1 from the local-runner package for a step-by-step diagnosis, then retry.',
  );
  assert.equal(getUserFacingMessage('RUNNER_PIPE_BROKEN'), getUserFacingMessage('Error when communicating with the native messaging host.'));
  await setLanguagePreference('AR');
  assert.equal(
    getUserFacingMessage('Error when communicating with the native messaging host.'),
    'انقطعت قناة الاتصال مع Local Runner. شغّل install\\doctor.ps1 من حزمة البرنامج المحلي للتشخيص الكامل ثم أعد المحاولة.',
  );
});

test("raw content-script delivery failure localizes for the user (issue #15)", async () => {
  await setLanguagePreference('EN');
  assert.equal(
    getUserFacingMessage('Could not establish connection. Receiving end does not exist.'),
    'Could not reach the page script in the X tab (it did not run in the browser). Reload the extension from chrome://extensions and retry; if it keeps failing, reinstall the updated extension package (1.5.5+).',
  );
  await setLanguagePreference('AR');
  assert.equal(
    getUserFacingMessage('Could not establish connection. Receiving end does not exist.'),
    'تعذّر الوصول إلى سكربت الصفحة في تبويب X (لم يُشغَّل في المتصفح). أعد تحميل الإضافة من chrome://extensions ثم أعد المحاولة، وإن استمر الخطأ فأعد تثبيت حزمة الإضافة المحدثة (1.5.5+).',
  );
  // Unrelated messages pass through untouched.
  assert.equal(getUserFacingMessage('some unrelated failure'), 'some unrelated failure');
});
