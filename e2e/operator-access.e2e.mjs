// UI defaults must not present Admin while the authoritative role is unknown.
// Server authorisation is covered separately by launch-regression.test.mjs.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadChromium, startApp } from './harness.mjs';
const chromium = loadChromium();
let app, browser;
before(async () => { if (chromium) { app = await startApp(); browser = await chromium.launch(); } });
after(async () => { await browser?.close(); app?.stop(); });

test('Admin stays closed while role lookup is pending and for an ordinary member', { skip: !chromium && 'Playwright is not installed' }, async () => {
  const page = await browser.newPage();
  let release;
  const pending = new Promise(r => { release = r; });
  await page.route('**/api/auth/me', async route => {
    await pending;
    await route.fulfill({ json: { required: true, operator: false, user: { id: '1', email: 'synthetic@example.test' } } });
  });
  try {
    await page.goto(app.url + '/#Admin');
    await page.getByText("Checking your session…", { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Admin', exact: true }).count(), 0);
    release();
    await page.waitForLoadState('networkidle');
    assert.equal(await page.getByRole('heading', { name: 'Admin', exact: true }).count(), 0);
  } finally { release(); await page.close(); }
});
