import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';

test('schema verification failure discards the pool before retrying', async t => {
  const originalCreatePool = mysql.createPool;
  const createdPools = [];

  mysql.createPool = () => {
    const poolNumber = createdPools.length + 1;
    const queries = [];
    const fakePool = {
      ended: false,
      pool: { on() {} },
      async query(sql) {
        queries.push(sql);
        if (sql === 'SELECT 1') return [[{ healthy: 1 }], []];
        throw new Error(`schema verification failed for pool ${poolNumber}`);
      },
      async end() {
        this.ended = true;
      },
    };
    fakePool.queries = queries;
    createdPools.push(fakePool);
    return fakePool;
  };

  const database = await import('../src/db.js?database-readiness-regression');
  t.after(async () => {
    await database.closePool();
    mysql.createPool = originalCreatePool;
  });

  await assert.rejects(
    database.initDatabase({ migrate: false }),
    /schema verification failed for pool 1/,
  );
  await assert.rejects(
    database.initDatabase({ migrate: false }),
    /schema verification failed for pool 2/,
  );

  assert.equal(createdPools.length, 2);
  assert.equal(createdPools[0].ended, true);
  assert.equal(createdPools[1].ended, true);
  assert.equal(createdPools[0].queries.includes('SELECT 1'), false);
  assert.equal(createdPools[1].queries.includes('SELECT 1'), false);
  assert.throws(() => database.getPool(), /has not been initialized/);

  const longDatabaseLock = database.migrationLockNameFor('a'.repeat(64));
  assert.ok(longDatabaseLock.length <= 64);
  assert.notEqual(longDatabaseLock, database.migrationLockNameFor('b'.repeat(64)));
});
