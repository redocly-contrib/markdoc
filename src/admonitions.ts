/**
 * The admonition kinds recognized in `> [!KIND]` markers. The first five are
 * GitHub's own set; the rest are common extensions in other dialects.
 */
export const ADMONITION_KINDS = [
  'note',
  'tip',
  'important',
  'warning',
  'caution',
  'info',
  'success',
  'danger',
] as const;
