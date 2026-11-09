import { z } from 'zod';

/** Per-connection FinTS configuration (stored encrypted as connection credentials). */
export const fintsConfigSchema = z
  .object({
    bank: z.enum(['dkb', 'comdirect']),
    userId: z.string().min(1).max(64),
    pin: z.string().min(1).max(64),
    tanMethodId: z.number().int().optional(),
  })
  .strict();

export type FinTSConnectionConfig = z.infer<typeof fintsConfigSchema>;
