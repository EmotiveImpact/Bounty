import { SvgXml } from "react-native-svg";

// Line icons from the website (src/proto/icons.tsx), drawn on a 24-unit
// grid. The markup is fixed here in the source, never built from data.
const PATHS: Record<string, string> = {
  deals:
    '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.4" fill="currentColor"/>',
  tips: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 9v6M11 9v6M14 9v6M17 9v6"/>',
  stock: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  money:
    '<circle cx="12" cy="12" r="9"/><path d="M14.5 8.5a2.5 2.5 0 0 0-4.5 1.5v5.5h-1.5M8.5 12.5h4.5M10 15.5h5.5"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  pin: '<path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  clothing: '<path d="M9 3 4 6v14h5V10M15 3l5 3v14h-5V10M9 3l3 4 3-4"/>',
  general:
    '<rect x="6" y="9" width="12" height="12" rx="2.5"/><path d="M12 9V6.5"/><path d="M12 2.8c1.2 1.3 1.2 2.6 0 3.4-1.2-.8-1.2-2.1 0-3.4z"/>',
  tech: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
  toys: '<circle cx="12" cy="13" r="7"/><circle cx="7" cy="6" r="2.5"/><circle cx="17" cy="6" r="2.5"/>',
  beauty: '<rect x="9" y="9" width="6" height="12" rx="1.5"/><path d="M10 9V5l4-2v6"/>',
};

export function Icon({
  name,
  size = 24,
  colour = "#111111",
  weight = 2,
}: {
  name: string;
  size?: number;
  colour?: string;
  weight?: number;
}) {
  const xml =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${weight}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${PATHS[name] ?? PATHS.general}</svg>`;
  return <SvgXml xml={xml} width={size} height={size} color={colour} />;
}
