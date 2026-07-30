import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, parseAuthUsers, parseTrustProxy } from '../src/auth.js';

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    cookies: [],
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    cookie(name, value, options) { this.cookies.push({ name, value, options }); return this; },
    clearCookie(name, options) { this.clearedCookie = { name, options }; return this; },
    set(name, value) { this.headers[name] = value; return this; },
  };
}

const productionEnv = {
  NODE_ENV: 'production',
  AUTH_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  AUTH_USERS_JSON: JSON.stringify([
    { username: 'manager-a', password: 'a-long-manager-password', role: 'manager' },
    { username: 'cashier-a', password: 'a-long-cashier-password', role: 'cashier' },
  ]),
};

test('đăng nhập tạo cookie HttpOnly và session khôi phục đúng vai trò', () => {
  const auth = createAuth({ env: productionEnv, now: () => 1_000_000 });
  const loginResponse = responseRecorder();
  auth.login({
    ip: '127.0.0.1',
    socket: {},
    body: { username: 'cashier-a', password: 'a-long-cashier-password' },
  }, loginResponse);

  assert.equal(loginResponse.statusCode, 200);
  assert.equal(loginResponse.body.user.role, 'cashier');
  assert.equal(loginResponse.cookies[0].options.httpOnly, true);
  assert.equal(loginResponse.cookies[0].options.sameSite, 'strict');
  assert.equal(loginResponse.cookies[0].options.secure, true);

  const request = {
    headers: { cookie: `${loginResponse.cookies[0].name}=${loginResponse.cookies[0].value}` },
  };
  let authenticated = false;
  auth.requireAuth(request, responseRecorder(), () => { authenticated = true; });
  assert.equal(authenticated, true);
  assert.deepEqual(request.user, { username: 'cashier-a', role: 'cashier' });
});

test('RBAC chặn vai trò không được cấp quyền', () => {
  const auth = createAuth({ env: productionEnv });
  const forbidden = responseRecorder();
  auth.allowRoles('manager')({ user: { username: 'cashier-a', role: 'cashier' } }, forbidden, () => {
    throw new Error('Không được gọi next cho vai trò bị chặn.');
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.body.error, 'FORBIDDEN');
});

test('cấu hình nhiều tài khoản và trust proxy được kiểm tra chặt', () => {
  assert.equal(parseAuthUsers(productionEnv).length, 2);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('false'), false);
  assert.throws(
    () => parseAuthUsers({ AUTH_USERS_JSON: '[{"username":"x","password":"short","role":"owner"}]' }),
    /không hợp lệ/,
  );
});
