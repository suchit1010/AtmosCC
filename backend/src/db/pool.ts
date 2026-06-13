import { Pool, PoolClient } from 'pg';
import { logger } from '../utils/logger';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/atmos_cc',
  max:              parseInt(process.env.DATABASE_POOL_SIZE || '10'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => logger.error('DB pool error', { error: err.message }));

export async function query<T = any>(text: string, params?: any[]): Promise<{ rows: T[] }> {
  const start  = Date.now();
  const result = await pool.query(text, params);
  const dur    = Date.now() - start;
  if (dur > 1000) logger.warn('Slow query', { duration: dur, query: text.slice(0, 80) });
  return result;
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function connectDB(): Promise<void> {
  try {
    await pool.query('SELECT 1');
    logger.info('Database connected');
  } catch (err: any) {
    logger.warn('Database unavailable (mock mode active)', { error: err.message });
  }
}
