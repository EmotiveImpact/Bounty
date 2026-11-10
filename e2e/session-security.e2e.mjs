// Synthetic accounts and data only. The browser exercises real UI state and
// HTTP failures; server authorisation has separate route-level regressions.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadChromium, startApp } from './harness.mjs';
const chromium = loadChromium();
const options = { skip: !chromium && 'Playwright is not installed' };
let app, browser;
before(async () => { if (chromium) { app = await startApp(); browser = await chromium.launch(); } });
after(async () => { await browser?.close(); app?.stop(); });
const memberKey = id => 'bounty:member:' + createHash('sha256').update('member:' + id).digest('hex') + ':';
async function sessionPage(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const state = { id: '1', email: 'alice@example.test', failSignOut: false, failSession: false };
  await page.addInitScript(({ prefix }) => {
    localStorage.setItem('bounty-onboarded', 'true');
    localStorage.setItem(prefix + 'bounty-onboarded', 'true');
  }, { prefix: memberKey(state.id) });
  await page.route('**/api/auth/me', route => route.fulfill(state.failSession
    ? { status: 503, json: { error: 'Synthetic unavailable session store' } }
    : { json: { required: true, inviteOpen: true, operator: false, user: state.email ? { id: state.id, email: state.email, name: 'Synthetic member' } : null } }));
  await page.route('**/api/auth/signout', route => {
    if (state.failSignOut) return route.fulfill({ status: 503, json: { error: 'Synthetic failed commit' } });
    state.email = null;
    return route.fulfill({ json: { ok: true } });
  });
  return { page, state };
}
async function openAccount(page) { await page.getByRole('button', { name: 'Your account', exact: true }).click(); }
async function skipOnboarding(page) {
  const skip = page.getByRole('button', { name: 'Skip for now', exact: true });
  if (await skip.isVisible()) await skip.click();
}

test('security: failed sign-out stays signed in and explains the active-session risk', options, async () => {
  const context = await browser.newContext();
  const { page, state } = await sessionPage(context);
  try {
    state.failSignOut = true;
    await page.goto(app.url);
    await openAccount(page);
    await page.getByRole('button', { name: 'Sign out (alice@example.test)', exact: true }).click();
    await page.getByRole('heading', { name: 'Sign-out not confirmed', exact: true }).waitFor();
    assert.match(await page.getByRole('alert').innerText(), /session may still be active/);
    assert.equal(await page.getByRole('button', { name: 'Sign out (alice@example.test)', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).count(), 0);
  } finally { await context.close(); }
});

test('security: account change discards previous screen state and isolates browser drafts', options, async () => {
  const context = await browser.newContext();
  const { page, state } = await sessionPage(context);
  try {
    await page.addInitScript(({ prefix }) => {
      localStorage.setItem('bounty-name', JSON.stringify('Alice private draft'));
      localStorage.setItem(prefix + 'bounty-name', JSON.stringify('Alice private draft'));
    }, { prefix: memberKey(state.id) });
    await page.goto(app.url);
    await openAccount(page);
    await page.getByText('Alice private draft', { exact: true }).waitFor();
    // A server-side session change in another tab must invalidate this tab's
    // state when focus returns, even if the old Stock screen is still open.
    state.id = '2';
    state.email = 'bob@example.test';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: 'Your account', exact: true }).waitFor();
    await skipOnboarding(page);
    await openAccount(page);
    await page.getByRole('button', { name: 'Sign out (bob@example.test)', exact: true }).waitFor();
    assert.equal(await page.getByText('Alice private draft', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('bounty-name'))), 'Alice private draft', 'unowned records are preserved, never silently adopted or deleted');
    await page.getByRole('button', { name: 'Sign out (bob@example.test)', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    assert.equal(await page.getByText('Alice private draft', { exact: true }).count(), 0);
  } finally { await context.close(); }
});

test('security: unavailable session lookup does not mount private screens and can retry', options, async () => {
  const context = await browser.newContext();
  const { page, state } = await sessionPage(context);
  try {
    state.failSession = true;
    await page.goto(app.url + '/#Stock');
    await page.getByRole('button', { name: 'Retry session check', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Stock', exact: true }).count(), 0);
    state.failSession = false;
    await page.getByRole('button', { name: 'Retry session check', exact: true }).click();
    await page.getByRole('heading', { name: 'Stock', exact: true }).waitFor();
  } finally { await context.close(); }
});
