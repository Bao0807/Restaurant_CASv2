import crypto from 'node:crypto';

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;

function normalizeDetails(details) {
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  );
}

export function logEvent(level, event, details = {}) {
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...normalizeDetails(details),
  });
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${record}\n`);
}

export function requestContext(req, res, next) {
  const forwarded = req.get('x-request-id');
  req.requestId = forwarded && REQUEST_ID_PATTERN.test(forwarded)
    ? forwarded
    : crypto.randomUUID();
  res.set('X-Request-Id', req.requestId);
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logEvent(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', 'http_request', {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(1)),
      actor: req.user?.username,
      role: req.user?.role,
      ip: req.ip,
    });
  });
  next();
}

export function errorDetails(error) {
  return {
    errorName: error?.name,
    errorCode: error?.code,
    errorMessage: error?.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack,
  };
}
