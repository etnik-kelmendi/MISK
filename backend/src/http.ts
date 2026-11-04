export const uuidParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

function pgCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

export const isUniqueViolation = (error: unknown) => pgCode(error) === '23505';
export const isForeignKeyViolation = (error: unknown) => pgCode(error) === '23503';
export const isExclusionViolation = (error: unknown) => pgCode(error) === '23P01';
