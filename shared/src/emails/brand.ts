/**
 * Veilguard brand tokens for EMAIL — literal hex values pulled from the frontend
 * (globals.css / data.ts / hooks.ts). Literals, not CSS vars: email clients don't
 * support custom properties. The typeface is a web-safe stack on purpose — Gmail/
 * Outlook strip custom web fonts; the brand lands via logo + color + layout + tone.
 */
export const BRAND = {
  bg: '#ECEBE7', // page background (warm off-white)
  card: '#FFFFFF',
  ink: '#1E1D1B', // dark text / buttons
  text: '#1E1D1B',
  muted: '#5b5a56',
  label: '#8b8a86',
  border: '#E4E3DE',
  yellow: '#F3C500', // brand accent
  yellowDark: '#8a7400',
  // severity / grade (must match the app's grade UI)
  critical: '#E5352B',
  warning: '#F2851F',
  safe: '#1FB86B',
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  logoUrl: 'https://veilguard.dev/logos/logo-mark.png',
  site: 'https://veilguard.dev',
} as const;

/** Grade → solid color, matching GRADE_TINT in the frontend (A/B green, C amber, D/F red). */
export function gradeColor(g?: string | null): string {
  if (g === 'A' || g === 'B') return BRAND.safe;
  if (g === 'C') return BRAND.warning;
  if (g === 'D' || g === 'F') return BRAND.critical;
  return BRAND.muted;
}

/** Finding severity → pill color (critical/high red, medium amber, low/info green). */
export function severityColor(sev: string): string {
  const s = sev.toLowerCase();
  if (s === 'critical' || s === 'high') return BRAND.critical;
  if (s === 'medium') return BRAND.warning;
  return BRAND.safe;
}
