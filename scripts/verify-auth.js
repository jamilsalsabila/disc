'use strict';

require('dotenv').config({ path: '.env', quiet: true });

const { createServer } = require('../src/server');

const authDisabled = String(process.env.HR_AUTH_DISABLED || '').toLowerCase() === 'true';
const hrEmail = process.env.HR_LOGIN_EMAIL || '';
const hrPassword = process.env.HR_LOGIN_PASSWORD || process.argv[2] || '';

const results = [];

function ok(name, detail) {
  results.push({ name, pass: true, detail });
}

function fail(name, detail) {
  results.push({ name, pass: false, detail });
}

function printAndExit() {
  let failed = 0;
  for (const r of results) {
    const tag = r.pass ? '[PASS]' : '[FAIL]';
    // eslint-disable-next-line no-console
    console.log(`${tag} ${r.name}${r.detail ? ` - ${r.detail}` : ''}`);
    if (!r.pass) {
      failed += 1;
    }
  }

  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`\nHealth-check selesai dengan ${failed} kegagalan.`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('\nHealth-check sukses.');
  process.exit(0);
}

(async () => {
  const server = await createServer();

  try {
    const home = await server.inject('/');
    if (home.statusCode === 200 || home.statusCode === 302) {
      ok('GET /', `status ${home.statusCode}`);
    } else {
      fail('GET /', `status ${home.statusCode}`);
    }

    const hrLogin = await server.inject('/hr/login');
    if (authDisabled) {
      if (hrLogin.statusCode === 302 && hrLogin.headers.location === '/hr/dashboard') {
        ok('GET /hr/login', 'auth bypass aktif');
      } else {
        fail('GET /hr/login', `expected 302 -> /hr/dashboard, got ${hrLogin.statusCode}`);
      }
    } else if (hrLogin.statusCode === 200) {
      ok('GET /hr/login', 'status 200');
    } else {
      fail('GET /hr/login', `expected 200, got ${hrLogin.statusCode}`);
    }

    const hrDashNoAuth = await server.inject('/hr/dashboard');
    if (authDisabled) {
      if (hrDashNoAuth.statusCode === 200) {
        ok('GET /hr/dashboard without auth', 'status 200 (bypass)');
      } else {
        fail('GET /hr/dashboard without auth', `expected 200, got ${hrDashNoAuth.statusCode}`);
      }
    } else if (hrDashNoAuth.statusCode === 302 && hrDashNoAuth.headers.location === '/hr/login') {
      ok('GET /hr/dashboard without auth', 'redirect ke /hr/login');
    } else {
      fail('GET /hr/dashboard without auth', `expected 302 -> /hr/login, got ${hrDashNoAuth.statusCode}`);
    }

    if (authDisabled) {
      const hrDash = await server.inject('/hr/dashboard');
      if (hrDash.statusCode === 200) {
        ok('GET /hr/dashboard (bypass)', 'status 200');
      } else {
        fail('GET /hr/dashboard (bypass)', `status ${hrDash.statusCode}`);
      }
    } else if (!hrEmail || !hrPassword) {
      ok(
        'POST /hr/login',
        'SKIPPED (set HR_LOGIN_PASSWORD di .env atau jalankan: npm run verify:health -- "PasswordAnda")'
      );
    } else {
      const login = await server.inject({
        method: 'POST',
        url: '/hr/login',
        payload: {
          email: hrEmail,
          password: hrPassword
        }
      });

      if (login.statusCode === 302 && login.headers.location === '/hr/dashboard') {
        ok('POST /hr/login', 'login berhasil');
      } else {
        fail('POST /hr/login', `expected 302 -> /hr/dashboard, got ${login.statusCode}`);
      }

      const tokenCookieRaw = (login.headers['set-cookie'] || []).find((c) => c.startsWith('hr_access_token='));
      if (!tokenCookieRaw) {
        fail('JWT cookie', 'hr_access_token tidak ditemukan');
      } else {
        ok('JWT cookie', 'hr_access_token diset');

        const cookieHeader = tokenCookieRaw.split(';')[0];
        const api = await server.inject({
          method: 'GET',
          url: '/hr/api/candidates',
          headers: { cookie: cookieHeader }
        });

        if (api.statusCode === 200) {
          ok('GET /hr/api/candidates with auth', 'status 200');
        } else {
          fail('GET /hr/api/candidates with auth', `status ${api.statusCode}`);
        }

        const logout = await server.inject({
          method: 'POST',
          url: '/hr/logout',
          headers: { cookie: cookieHeader }
        });

        if (logout.statusCode === 302 && logout.headers.location === '/hr/login') {
          ok('POST /hr/logout', 'logout berhasil');
        } else {
          fail('POST /hr/logout', `expected 302 -> /hr/login, got ${logout.statusCode}`);
        }
      }
    }
  } catch (err) {
    fail('Unhandled error', err.message);
  } finally {
    await server.stop();
    printAndExit();
  }
})();
