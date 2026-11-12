import { z } from 'zod';
import { CATEGORY_COLOR_KEYS, CATEGORY_ICONS } from '../category-style';

/** A household category. Names are plaintext by design; archived ones stay listed so old transactions resolve. */
export const categoryInfo = z.object({
  id: z.string(),
  name: z.string(),
  group: z.string().nullable(),
  isIncome: z.boolean(),
  isTransfer: z.boolean(),
  archived: z.boolean(),
  /** MDI glyph name from `CATEGORY_ICONS`, or null (clients fall back to `tag`). */
  icon: z.string().nullable(),
  /** Palette key from `CATEGORY_COLOR_KEYS`, or null (clients derive one from the id). */
  color: z.string().nullable(),
});
export type CategoryInfo = z.infer<typeof categoryInfo>;

export const categoryListResponse = z.object({ categories: z.array(categoryInfo) });
export type CategoryListResponse = z.infer<typeof categoryListResponse>;

const categoryName = z.string().trim().min(1).max(40);
/** Empty (after trim) clears the group. */
const categoryGroup = z
  .string()
  .trim()
  .max(40)
  .transform((g) => (g === '' ? null : g));

export const createCategoryRequest = z.object({
  name: categoryName,
  group: categoryGroup.optional(),
  isIncome: z.boolean().optional(),
  icon: z.enum(CATEGORY_ICONS).optional(),
  color: z.enum(CATEGORY_COLOR_KEYS).optional(),
});
export type CreateCategoryRequest = z.infer<typeof createCategoryRequest>;

export const patchCategoryRequest = z
  .object({
    name: categoryName.optional(),
    group: categoryGroup.optional(),
    archived: z.boolean().optional(),
    /** `null` clears the stored icon/colour. */
    icon: z.enum(CATEGORY_ICONS).nullable().optional(),
    color: z.enum(CATEGORY_COLOR_KEYS).nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: 'At least one field is required',
  });
export type PatchCategoryRequest = z.infer<typeof patchCategoryRequest>;

export const categoryIdParams = z.object({ id: z.uuid() });
export const categoryResponse = z.object({ category: categoryInfo });
export type CategoryResponse = z.infer<typeof categoryResponse>;

/** A rule its creator made. `value` is sensitive (an IBAN or counterparty text): never log it. */
export const ruleInfo = z.object({
  id: z.string(),
  categoryId: z.string(),
  match: z.object({ kind: z.enum(['iban', 'counterpartyContains']), value: z.string() }),
  createdAt: z.string(),
});
export type RuleInfo = z.infer<typeof ruleInfo>;
export const ruleListResponse = z.object({ rules: z.array(ruleInfo) });
export type RuleListResponse = z.infer<typeof ruleListResponse>;
export const ruleIdParams = z.object({ id: z.uuid() });
