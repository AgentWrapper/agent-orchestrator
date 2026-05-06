export function isPortfolioEnabled(): boolean {
  const value = process.env["AO_ENABLE_PORTFOLIO"];
  if (value === "0" || value === "false") return false;
  return true;
}
