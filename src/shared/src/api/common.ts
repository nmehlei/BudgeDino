import { z } from 'zod';

/** Error body of every non-2xx response. Never contains request data. */
export const errorResponse = z.object({
  error: z.string(),
  message: z.string(),
  issues: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional()
    .describe('Only on 400 validation errors; field paths and rule messages, never values.'),
});
export type ErrorResponse = z.infer<typeof errorResponse>;

export const role = z.enum(['admin', 'member']);
export type Role = z.infer<typeof role>;
