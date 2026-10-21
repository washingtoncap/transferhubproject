import { Pool } from 'pg';
import type { Config } from '../../platform/src/config.js';
import { log } from '../../platform/src/log.js';
export interface Database { query<T extends Record<string,unknown> = Record<string,unknown>>(sql:string,params?:unknown[]):Promise<{rows:T[]}>; close():Promise<void>; }
export function connectDatabase(config:Config): Database {
 const pool=new Pool({connectionString:config.DATABASE_URL,ssl:config.DATABASE_SSL==='true'?{rejectUnauthorized:true}:false,max:5,connectionTimeoutMillis:5000,statement_timeout:10000});
 pool.on('error',()=>log('database.pool_error'));
 return {async query<T extends Record<string,unknown>>(sql:string,params:unknown[]=[]) {const r=await pool.query(sql,params);return {rows:r.rows as T[]};},close:()=>pool.end()};
}
