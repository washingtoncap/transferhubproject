import { z } from 'zod';
export const diagnosticJobSchema = z.object({ message: z.string().trim().min(1).max(120) }).strict();
export type DiagnosticPayload = z.infer<typeof diagnosticJobSchema>;
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'dead';
export interface PlatformStatus { name: 'TransferHub'; mode: 'sandbox'; bucket: 1; financialServicesEnabled: false; }
export interface ApiError { error: { code: string; message: string; requestId: string }; }
export const platformStatus: PlatformStatus = { name:'TransferHub', mode:'sandbox', bucket:1, financialServicesEnabled:false };
