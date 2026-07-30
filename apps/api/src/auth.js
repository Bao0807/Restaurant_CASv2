import crypto from 'node:crypto';

export const AUTH_ROLES = new Set(['manager', 'cashier', 'server', 'chef']);

const SESSION_COOKIE = 'cas_session';
const DEFAULT_SESSION_HOURS = 8;
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 60_000;

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual ?? ''));
  const expectedBuffer = Buffer.from(String(expected ?? ''));
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseCookies(header = '') {
  return String(header).split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = '';
      }
    }
    return cookies;
  }, {});
}

function parseSessionHours(value) {
  const hours = Number(value ?? DEFAULT_SESSION_HOURS);
  return Number.isInteger(hours) && hours >= 1 && hours <= 24 * 30
    ? hours
    : DEFAULT_SESSION_HOURS;
}

export function parseAuthUsers(env = process.env) {
  if (env.AUTH_USERS_JSON) {
    let rows;
    try {
      rows = JSON.parse(env.AUTH_USERS_JSON);
    } catch {
      throw new Error('AUTH_USERS_JSON phải là JSON hợp lệ.');
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('AUTH_USERS_JSON phải là một mảng tài khoản không rỗng.');
    }
    const usernames = new Set();
    return rows.map((row, index) => {
      const username = typeof row?.username === 'string' ? row.username.trim() : '';
      const password = typeof row?.password === 'string' ? row.password : '';
      const role = typeof row?.role === 'string' ? row.role.trim() : '';
      if (!username || username.length > 80 || !password || password.length < 12 || !AUTH_ROLES.has(role)) {
        throw new Error(`Tài khoản AUTH_USERS_JSON tại vị trí ${index} không hợp lệ.`);
      }
      if (usernames.has(username)) throw new Error(`AUTH_USERS_JSON bị trùng tài khoản ${username}.`);
      usernames.add(username);
      return { username, password, role };
    });
  }

  if (env.AUTH_USERNAME && env.AUTH_PASSWORD) {
    return [{ username: env.AUTH_USERNAME, password: env.AUTH_PASSWORD, role: 'manager' }];
  }
  return [];
}

function createToken(user, secret, expiresAt) {
  const encodedPayload = Buffer.from(JSON.stringify({
    version: 1,
    username: user.username,
    role: user.role,
    expiresAt,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifySessionToken(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const [encodedPayload, signature, extra] = String(token).split('.');
  if (!encodedPayload || !signature || extra || !safeEqual(
    signature,
    crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url'),
  )) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (
      payload?.version !== 1
      || typeof payload.username !== 'string'
      || !AUTH_ROLES.has(payload.role)
      || !Number.isSafeInteger(payload.expiresAt)
      || payload.expiresAt <= now
    ) return null;
    return { username: payload.username, role: payload.role, expiresAt: payload.expiresAt };
  } catch {
    return null;
  }
}

export function parseTrustProxy(value) {
  if (value == null || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function createAuth({ env = process.env, now = () => Date.now() } = {}) {
  const isProduction = env.NODE_ENV === 'production';
  const users = parseAuthUsers(env);
  const authRequired = isProduction || users.length > 0;
  const configuredSecret = env.AUTH_SESSION_SECRET || '';
  const sessionSecret = configuredSecret || (!isProduction && users[0]
    ? crypto.createHash('sha256').update(`cas-dev-session:${users[0].password}`).digest('hex')
    : '');
  const authConfigured = users.length > 0 && sessionSecret.length >= 32;
  const sessionDurationMs = parseSessionHours(env.AUTH_SESSION_HOURS) * 60 * 60_000;
  const attempts = new Map();

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict',
    secure: isProduction,
    path: '/api',
  };

  function clearExpiredAttempts(currentTime) {
    if (attempts.size < 100) return;
    for (const [key, attempt] of attempts) {
      if (attempt.resetAt <= currentTime) attempts.delete(key);
    }
  }

  function login(req, res) {
    if (!authRequired) {
      res.json({ ok: true, authRequired: false, user: { username: 'local-development', role: 'manager' } });
      return;
    }
    if (!authConfigured) {
      res.status(503).json({
        error: 'AUTH_NOT_CONFIGURED',
        message: 'Xác thực production chưa được cấu hình đầy đủ.',
      });
      return;
    }

    const attemptKey = req.ip || req.socket.remoteAddress || 'unknown';
    const currentTime = now();
    clearExpiredAttempts(currentTime);
    const previous = attempts.get(attemptKey);
    const attempt = previous && previous.resetAt > currentTime
      ? previous
      : { count: 0, resetAt: currentTime + LOGIN_WINDOW_MS };
    if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
      res.set('Retry-After', String(Math.ceil((attempt.resetAt - currentTime) / 1000)));
      res.status(429).json({
        error: 'TOO_MANY_AUTH_ATTEMPTS',
        message: 'Quá nhiều lần đăng nhập sai. Vui lòng thử lại sau.',
      });
      return;
    }

    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const user = users.find(candidate => safeEqual(candidate.username, username));
    if (!user || !safeEqual(user.password, password)) {
      attempt.count += 1;
      attempts.set(attemptKey, attempt);
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Tên đăng nhập hoặc mật khẩu không đúng.',
      });
      return;
    }

    attempts.delete(attemptKey);
    const expiresAt = currentTime + sessionDurationMs;
    res.cookie(SESSION_COOKIE, createToken(user, sessionSecret, expiresAt), {
      ...cookieOptions,
      maxAge: sessionDurationMs,
    });
    res.json({
      ok: true,
      authRequired: true,
      user: { username: user.username, role: user.role },
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  function logout(_req, res) {
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.json({ ok: true });
  }

  function requireAuth(req, res, next) {
    if (!authRequired) {
      req.user = { username: 'local-development', role: 'manager' };
      next();
      return;
    }
    if (!authConfigured) {
      res.status(503).json({
        error: 'AUTH_NOT_CONFIGURED',
        message: 'Xác thực production chưa được cấu hình đầy đủ.',
      });
      return;
    }
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = verifySessionToken(token, sessionSecret, now());
    const currentUser = session
      ? users.find(user => safeEqual(user.username, session.username) && user.role === session.role)
      : null;
    if (!session || !currentUser) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' });
      return;
    }
    req.user = { username: session.username, role: session.role };
    next();
  }

  function allowRoles(...roles) {
    const allowed = new Set(roles);
    return (req, res, next) => {
      if (req.user && allowed.has(req.user.role)) {
        next();
        return;
      }
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Tài khoản không có quyền thực hiện thao tác này.',
      });
    };
  }

  return {
    authConfigured,
    authRequired,
    allowRoles,
    login,
    logout,
    requireAuth,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}
