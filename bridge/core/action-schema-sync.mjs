export function compareActionSchema(oldSchema, newSchema) {
  const oldUrl = oldSchema?.servers?.[0]?.url ?? null;
  const newUrl = newSchema?.servers?.[0]?.url ?? null;
  if (oldUrl !== newUrl) {
    return {
      status: 'outdated',
      reason: 'public endpoint changed',
      oldUrl,
      newUrl,
      requiredAction: 'refresh schema'
    };
  }
  return { status: 'valid', reason: 'schema endpoint matches' };
}
