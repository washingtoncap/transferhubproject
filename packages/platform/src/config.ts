import { z } from 'zod';
const schema = z.object({
 NODE_ENV:z.enum(['development','test','production']).default('development'),
 PLATFORM_MODE:z.literal('sandbox').default('sandbox'),
 DATABASE_URL:z.string().url().refine(v=>v.startsWith('postgresql://')||v.startsWith('postgres://')),
 DATABASE_SSL:z.enum(['true','false']).default('false'),
 API_PORT:z.coerce.number().int().min(1).max(65535).default(4000),
 API_HOST:z.string().default('127.0.0.1'),
 API_ORIGIN:z.string().url().default('http://localhost:3000'),
 DIAGNOSTICS_TOKEN:z.string().min(32).refine(v=>!v.startsWith('replace-'),'Generate a random token'),
 WORKER_POLL_MS:z.coerce.number().int().min(100).max(10000).default(1000),
 WORKER_LEASE_SECONDS:z.coerce.number().int().min(10).max(300).default(30),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env:NodeJS.ProcessEnv=process.env):Config {
 const result=schema.safeParse(env);
 if(!result.success) throw new Error(`Invalid configuration fields: ${result.error.issues.map(i=>i.path.join('.')).join(', ')}`);
 if(result.data.NODE_ENV==='production' && (!result.data.API_ORIGIN.startsWith('https://') || result.data.DATABASE_SSL!=='true')) throw new Error('Hosted sandbox requires HTTPS origin and verified database TLS');
 return result.data;
}
