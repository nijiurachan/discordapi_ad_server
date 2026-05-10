import { z } from 'zod';

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

export const adFormatRulesSchema = z.object({
  slot: z.string().min(1).max(64),
  allowedMimes: z.array(z.string().regex(/^image\/(png|jpeg|gif|webp)$/)).min(1),
  allowedExtensions: z.array(z.string().regex(/^[a-z0-9]+$/)).min(1),
  maxBytes: positiveInt,
  minWidth: nonNegativeInt.optional().nullable(),
  maxWidth: positiveInt.optional().nullable(),
  minHeight: nonNegativeInt.optional().nullable(),
  maxHeight: positiveInt.optional().nullable(),
  aspectRatios: z
    .array(z.string().regex(/^\d+:\d+$/))
    .optional()
    .nullable(),
  aspectTolerance: z.number().min(0).max(1).optional(),
  titleMaxLen: positiveInt.max(500).default(80),
  bodyMaxLen: positiveInt.max(4000).default(500),
  linkUrlMaxLen: positiveInt.max(8192).default(2048),
  linkScheme: z.array(z.enum(['https', 'http'])).default(['https']),
  linkDomainAllowlist: z.array(z.string().min(1)).optional().nullable(),
  linkDomainBlocklist: z.array(z.string().min(1)).optional().nullable(),
});

export type AdFormatRulesInput = z.infer<typeof adFormatRulesSchema>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function parseAdFormatRules(input: unknown): ParseResult<AdFormatRulesInput> {
  const result = adFormatRulesSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  const errors = result.error.issues.map((iss) => {
    const path = iss.path.length > 0 ? iss.path.join('.') : '(root)';
    return `${path}: ${iss.message}`;
  });
  return { ok: false, errors };
}
