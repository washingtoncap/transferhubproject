import { createHash } from 'node:crypto';
import { readdir,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { Config } from '../../platform/src/config.js';
export async function migrate(config:Config) {
 const pool=new Pool({connectionString:config.DATABASE_URL,ssl:config.DATABASE_SSL==='true'?{rejectUnauthorized:true}:false,connectionTimeoutMillis:5000});
 const client=await pool.connect();
 try {
  await client.query('SELECT pg_advisory_lock(907114)');
  await client.query('CREATE TABLE IF NOT EXISTS public.schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const dir=resolve(process.cwd(),'database/migrations');
  for(const name of (await readdir(dir)).filter(n=>/^\d+_.+\.sql$/.test(n)).sort()) {
   const sql=await readFile(resolve(dir,name),'utf8');const hash=createHash('sha256').update(sql).digest('hex');
   const existing=await client.query('SELECT checksum FROM public.schema_migrations WHERE name=$1',[name]);
   if(existing.rows.length){if(existing.rows[0].checksum!==hash)throw new Error('Applied migration checksum mismatch');continue;}
   await client.query('BEGIN');
   try {await client.query(sql);await client.query('INSERT INTO public.schema_migrations(name,checksum) VALUES($1,$2)',[name,hash]);await client.query('COMMIT');}
   catch(err){await client.query('ROLLBACK');throw err;}
  }
 } finally {await client.query('SELECT pg_advisory_unlock(907114)');client.release();await pool.end();}
}
