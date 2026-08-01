const plausibleUsSymbolPattern = /^[A-Z][A-Z0-9]{0,5}(?:[.-][A-Z])?$/;

export function normalizeSecuritySymbol(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function isPlausibleUsSecuritySymbol(value: unknown) {
  return plausibleUsSymbolPattern.test(normalizeSecuritySymbol(value));
}

export const usSecuritySymbolHelp = "Use a symbol such as AAPL, GOOGL, BRK.B, BABA, or VOO. The local server confirms the symbol against Nasdaq's US directory; ticker shape alone is not treated as proof.";

// Backwards-compatible names. These only check syntax; the server registry verifies the listing.
export const normalizeUsListedTicker = normalizeSecuritySymbol;
export const isSupportedUsListedTicker = isPlausibleUsSecuritySymbol;
export const usListedTickerHelp = usSecuritySymbolHelp;
