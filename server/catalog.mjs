// Synthetic planning fixtures. Monetary values use integer pence.
export const offers = [
  {
    sku: "knit",
    name: "Cotton crew-neck jumper",
    variant: "Navy · Medium · New",
    shop: "Morrisons",
    area: "Leeds",
    miles: 1.2,
    buy: 600,
    sales: [1550, 1600, 1650, 1690, 1700],
    post: 270,
    pack: 35,
    weight: 0.32,
    stock: 6,
    minutes: 9,
  },
  {
    sku: "baby",
    name: "Baby sleepsuits",
    variant: "Three-pack · 0–3 months · New",
    shop: "Asda",
    area: "Leeds",
    miles: 1.6,
    buy: 450,
    sales: [1250, 1300, 1350, 1400],
    post: 245,
    pack: 25,
    weight: 0.24,
    stock: 8,
    minutes: 7,
  },
  {
    sku: "pot",
    name: "Terracotta planter",
    variant: "32 cm · Single · New",
    shop: "B&Q",
    area: "Leeds",
    miles: 2.5,
    buy: 1200,
    sales: [3400, 3500, 3800],
    post: 790,
    pack: 180,
    weight: 10,
    stock: 3,
    minutes: 16,
  },
];
export const defaults = {
  area: "Leeds",
  budget: 100,
  target: 12,
  transport: "Walk",
  carry: 5,
  quantity: 4,
  travel: 0,
};
export function plan(o, p) {
  const sold = [...o.sales].sort((a, b) => a - b)[
    Math.floor((o.sales.length - 1) / 2)
  ];
  const fees = Math.round(sold * 0.13) + 40,
    reserve = Math.round(sold * 0.05);
  const trip = Math.round(p.travel * 100);
  const q = Math.max(
    0,
    Math.min(
      p.quantity,
      o.stock,
      Math.floor(p.carry / o.weight),
      Math.floor((p.budget * 100 - trip) / (o.buy + o.post + o.pack)),
    ),
  );
  const costs = {
    stock: q * o.buy,
    postage: q * o.post,
    packaging: q * o.pack,
    fees: q * fees,
    returns: q * reserve,
    travel: q ? trip : 0,
  };
  const proceeds = q * sold,
    profit = proceeds - Object.values(costs).reduce((a, b) => a + b, 0);
  const minutes = q
    ? Math.ceil(
        ((2 * o.miles) /
          { Walk: 3, Bicycle: 9, Car: 18, Van: 16 }[p.transport]) *
          60,
      ) +
      10 +
      o.minutes * q
    : 0;
  const hourly = minutes ? Math.round((profit * 60) / minutes) : 0;
  const reason =
    p.area.toLowerCase().trim() !== o.area.toLowerCase()
      ? "Outside your area"
      : !q
        ? "Budget or carrying limit"
        : hourly < p.target * 100
          ? "Below hourly target"
          : "Fits your profile";
  return { ...o, q, sold, costs, proceeds, profit, minutes, hourly, reason };
}
