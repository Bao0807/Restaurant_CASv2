import 'dotenv/config';
import { closePool, databaseConfigSummary, migrateDatabase } from './db.js';

try {
  await migrateDatabase();
  console.log(`Migration completed: ${databaseConfigSummary.host}:${databaseConfigSummary.port}/${databaseConfigSummary.database}`);
} catch (error) {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
}
