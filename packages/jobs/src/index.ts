import { createHash,randomUUID } from 'node:crypto';
import type { Database } from '../../database/src/db.js';
import { diagnosticJobSchema, type DiagnosticPayload, type JobStatus } from '../../contracts/src/index.js';
export class IdempotencyConflict extends Error {}
export interface Job extends Record<string,unknown> { id:string; status:JobStatus; attempts:number; payload:DiagnosticPayload; lease_token:string; result:unknown; }
export async function enqueue(db:Database,key:string,input:unknown) {
 const payload=diagnosticJobSchema.parse(input);
 const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 const insert=await db.query<Job>(`INSERT INTO platform.jobs(id,kind,payload,idempotency_key,payload_hash) VALUES($1,'diagnostic.ping',$2::jsonb,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,[randomUUID(),JSON.stringify(payload),key,hash]);
 const row=insert.rows[0] ?? (await db.query<Job>('SELECT * FROM platform.jobs WHERE idempotency_key=$1',[key])).rows[0];
 if(!row||row.payload_hash!==hash) throw new IdempotencyConflict('Key already used with a different payload');
 return row;
}
export async function claim(db:Database,leaseSeconds:number):Promise<Job|undefined> {
 // Dead-letter expired final attempts before claiming more work.
 await db.query(`UPDATE platform.jobs SET status='dead',lease_token=NULL,lease_until=NULL,last_error_code='LEASE_EXHAUSTED' WHERE status='running' AND lease_until<now() AND attempts>=max_attempts`);
 const r=await db.query<Job>(`WITH candidate AS (SELECT id FROM platform.jobs WHERE attempts<max_attempts AND ((status='queued' AND available_at<=now()) OR (status='running' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE platform.jobs j SET status='running',attempts=attempts+1,lease_token=$1,lease_until=now()+($2::int*interval '1 second') FROM candidate c WHERE j.id=c.id RETURNING j.*`,[randomUUID(),leaseSeconds]);
 return r.rows[0];
}
export async function complete(db:Database,job:Job) {
 // A lease token fences stale workers. Receipt and completion are one statement.
 const r=await db.query(`WITH finished AS (UPDATE platform.jobs SET status='succeeded',result='{"acknowledged":true}'::jsonb,completed_at=now(),lease_token=NULL,lease_until=NULL,last_error_code=NULL WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>now() RETURNING id) INSERT INTO platform.diagnostic_receipts(job_id) SELECT id FROM finished ON CONFLICT DO NOTHING RETURNING job_id`,[job.id,job.lease_token]);
 return r.rows.length===1;
}
export async function fail(db:Database,job:Job) {
 await db.query(`UPDATE platform.jobs SET status=CASE WHEN attempts>=max_attempts THEN 'dead' ELSE 'queued' END,available_at=now()+(power(2,attempts)::int*interval '1 second'),last_error_code='HANDLER_FAILED',lease_token=NULL,lease_until=NULL WHERE id=$1 AND status='running' AND lease_token=$2`,[job.id,job.lease_token]);
}
export async function processOne(db:Database,leaseSeconds:number) {
 const job=await claim(db,leaseSeconds);if(!job)return false;
 try{diagnosticJobSchema.parse(job.payload);await complete(db,job);}catch{await fail(db,job);}
 return true;
}
export async function heartbeat(db:Database,workerId:string) {
 await db.query('INSERT INTO platform.worker_heartbeats(worker_id) VALUES($1) ON CONFLICT(worker_id) DO UPDATE SET seen_at=now()',[workerId]);
 await db.query("DELETE FROM platform.worker_heartbeats WHERE seen_at<now()-interval '1 day'");
}
