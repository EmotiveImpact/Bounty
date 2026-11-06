// The agreed bold look (the website's apps/web/src/proto/proto-bold.css): a white
// canvas, one light bright tint per tab with dark text, Cal Sans headings and
// Google Sans for everything else.

export const colours = {
  ink: "#111111",
  inkSoft: "#4a4a4a",
  inkFaint: "#7a7a7a",
  line: "#e6e6e6",
  canvas: "#ffffff",
  panel: "#f6f6f4",
  brand: "#0b8a43",
  badge: "#ff7cc0",
  warn: "#b3261e",
  // One tint per tab.
  lime: "#d6f86b",
  sky: "#cfe4ff",
  periwinkle: "#a9bcff",
  peach: "#ffcfa8",
  candy: "#ffbfe0",
  pistachio: "#e4ecb0",
  butter: "#ffe58a",
  lemon: "#fff3a3",
  lilac: "#e6dcff",
} as const;

export type TabName = "deals" | "tips" | "scan" | "stock" | "money";

export const tabTint: Record<TabName, string> = {
  deals: colours.lime,
  tips: colours.sky,
  scan: colours.periwinkle,
  stock: colours.peach,
  money: colours.candy,
};

export const fonts = {
  display: "CalSans-Medium",
  text: "GoogleSans_400Regular",
  textMedium: "GoogleSans_500Medium",
  textBold: "GoogleSans_700Bold",
} as const;

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 } as const;
export const radius = { s: 10, m: 16, l: 24, pill: 999 } as const;
