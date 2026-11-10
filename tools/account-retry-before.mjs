// Pinned parent only; temporary checkout and fake API promises. No live calls.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
const parent = 'a6c501da48984869027285aa31d850336e20e700';
const before = mkdtempSync(join(tmpdir(), 'bounty-retry-before-'));
try {
  const archive = join(before, 'synthetic-parent.tar');
  execFileSync('git', ['archive', '--output=' + archive, parent]);
  execFileSync('tar', ['-xf', archive, '-C', before]); rmSync(archive);
  symlinkSync(resolve('node_modules'), join(before, 'node_modules'), 'dir');
  copyFileSync(resolve('apps/server/ledger-retry.test.mjs'), join(before, 'apps/server/ledger-retry.test.mjs'));
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'apps/server/ledger-retry.test.mjs'], {
    cwd: before, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, DATABASE_URL: '', BOUNTY_KEEP_DATA: 'off' },
  });
  process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || '');
  assert.equal(run.status, 1);
  assert.match(run.stdout, /# fail 4\b/); assert.match(run.stdout, /# skipped 0\b/);

  // Execute the original provider with a deterministic hook scheduler. This
  // reproduces JavaScript state transitions, not native navigation or cookies.
  const code = ts.transpileModule(readFileSync(join(before, 'apps/mobile/src/lib/auth.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  function mount(api) {
    const slots = [], effects = []; let cursor = 0, mounted = false;
    const hooks = {
      createContext: () => ({ Provider: 'provider' }), useContext: () => null,
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
        return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
      useEffect(fn) { if (!mounted) effects.push(fn); }, useMemo: fn => fn(), useCallback: fn => fn,
    };
    const exports = {};
    new Function('require', 'exports', code)(name => {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return { jsx: (_, props) => props };
      if (name === './api') return { api };
      throw Error('Unexpected baseline import: ' + name);
    }, exports);
    const render = () => { cursor = 0; const value = exports.AuthProvider({ children: null }).value; mounted = true; return value; };
    render(); effects.forEach(fn => fn());
    return render;
  }
  const alice = { id: '1', email: 'alice@example.test', name: 'Synthetic' };
  let resolveOld;
  const old = new Promise(resolve => { resolveOld = resolve; });
  const render = mount(async route => route === 'auth/me' ? old : {});
  await render().signOut(); resolveOld({ required: true, user: alice });
  await old; await new Promise(resolve => setImmediate(resolve));
  assert.equal(render().user.id, '1', 'parent resurrects an old identity after sign-out');
  let offline = false;
  const offlineRender = mount(async () => { if (offline) throw Error('synthetic offline'); return { required: true, user: alice }; });
  await new Promise(resolve => setImmediate(resolve));
  offline = true; await offlineRender().refresh();
  assert.equal(offlineRender().signedIn, true, 'parent retains private identity after failed revalidation');
  console.log('Confirmed 4 ledger regressions and 2 mobile provider state failures on pinned PR #33. Native-device behaviour remains unverified.');
} finally { rmSync(before, { recursive: true, force: true }); }
