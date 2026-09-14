export async function retry(operation, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  const delayMs = options.delayMs ?? 2000;

  let lastError;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await operation(i + 1);
    } catch (error) {
      lastError = error;
      if (i < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}
