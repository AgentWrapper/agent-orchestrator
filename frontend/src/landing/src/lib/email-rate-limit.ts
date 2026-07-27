// Stub - email rate limiting not needed for landing page
export async function checkEmailFormRateLimit(_email: string): Promise<boolean> {
  return false;
}
