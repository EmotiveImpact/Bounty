import React from "react";

// Line icons from the agreed desktop mock, drawn on a 24-unit grid. The
// markup is fixed here in the source, never built from data.
const SVG: Record<string, string> = {
  deals:
    '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.4" fill="currentColor"/>',
  tips: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 9v6M11 9v6M14 9v6M17 9v6"/>',
  stock:
    '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  money:
    '<circle cx="12" cy="12" r="9"/><path d="M14.5 8.5a2.5 2.5 0 0 0-4.5 1.5v5.5h-1.5M8.5 12.5h4.5M10 15.5h5.5"/>',
  planner:
    '<path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/>',
  research: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  sources:
    '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  pin: '<path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  heart:
    '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  out: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/><circle cx="8.5" cy="12" r=".6" fill="currentColor"/><circle cx="12" cy="12" r=".6" fill="currentColor"/><circle cx="15.5" cy="12" r=".6" fill="currentColor"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  // Category art
  clothing: '<path d="M9 3 4 6v14h5V10M15 3l5 3v14h-5V10M9 3l3 4 3-4"/>',
  general:
    '<rect x="6" y="9" width="12" height="12" rx="2.5"/><path d="M12 9V6.5"/><path d="M12 2.8c1.2 1.3 1.2 2.6 0 3.4-1.2-.8-1.2-2.1 0-3.4z"/>',
  all: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
};

export function Ico({ n, w = 2 }: { n: string; w?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: SVG[n] ?? SVG.general }}
    />
  );
}
