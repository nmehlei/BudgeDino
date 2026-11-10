import { z } from 'zod';

/** A household category. Names are plaintext by design; archived ones stay listed so old transactions resolve. */
export const categoryInfo = z.object({
  id: z.string(),
  name: z.string(),
  group: z.string().nullable(),
  isIncome: z.boolean(),
  isTransfer: z.boolean(),
  archived: z.boolean(),
});
export type CategoryInfo = z.infer<typeof categoryInfo>;

export const categoryListResponse = z.object({ categories: z.array(categoryInfo) });
export type CategoryListResponse = z.infer<typeof categoryListResponse>;
