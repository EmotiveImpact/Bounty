import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { api } from "@/lib/api";
import { money } from "@/lib/format";
import type { Deal } from "@/lib/types";
import { useLoad } from "@/lib/use-load";
import { DealRow } from "@/ui/deal-parts";
import { Empty, Figure, Figures, Hero, Loading, Notice, Problem, Screen, Section } from "@/ui/kit";
import { colours, fonts, radius, space, tabTint } from "@/ui/theme";

// Deals: finds cheaper in a shop near you than they sell for, checked
// against completed sales. Every figure comes from the Bounty server.

const CATEGORY: Record<string, string> = {
  clothing: "Clothing",
  general: "Home and general",
  toys: "Toys",
  beauty: "Beauty",
  tech: "Tech",
};
const catLabel = (c: string) => CATEGORY[c] ?? c.charAt(0).toUpperCase() + c.slice(1);

export default function DealsScreen() {
  const { data, error, refreshing, refresh, reload } = useLoad(() => api<{ deals: Deal[] }>("deals"));
  const [cat, setCat] = useState<string | null>(null);

  const deals = useMemo(() => data?.deals ?? [], [data]);
  const cats = useMemo(() => [...new Set(deals.map((d) => d.category))].sort(), [deals]);
  const shown = useMemo(
    () =>
      deals
        .filter((d) => !cat || d.category === cat)
        .sort((a, b) => Number(b.verdict === "buy") - Number(a.verdict === "buy") || (b.unitProfit ?? -1e9) - (a.unitProfit ?? -1e9)),
    [deals, cat],
  );
  const buys = deals.filter((d) => d.verdict === "buy");
  const sample = deals.some((d) => d.sample);
  const topFour = buys.slice().sort((a, b) => (b.unitProfit ?? 0) - (a.unitProfit ?? 0)).slice(0, 4);

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Hero
        tint={tabTint.deals}
        kicker={sample ? "Sample deals" : "Checked against completed sales"}
        title="Today’s top deals."
        lead="Cheaper on the shelf near you than they sell for, sorted by what you keep."
      >
        {data ? (
          <Figures>
            <Figure value={String(buys.length)} label={buys.length === 1 ? "buy right now" : "buys right now"} style={styles.heroFigure} />
            <Figure
              value={money(topFour.reduce((a, d) => a + (d.unitProfit ?? 0), 0))}
              label={`to keep from the top ${topFour.length}`}
              style={styles.heroFigure}
            />
          </Figures>
        ) : null}
      </Hero>

      {sample ? (
        <Notice>These are sample deals with made-up figures, so you can see how Bounty works. They are not real offers.</Notice>
      ) : null}

      {cats.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {[null, ...cats].map((c) => {
            const on = cat === c;
            return (
              <Pressable
                key={c ?? "all"}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setCat(c)}
                style={[styles.chip, on && styles.chipOn]}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{c ? catLabel(c) : "All"}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {error && !data ? <Problem message={error} onRetry={reload} /> : null}
      {!data && !error ? <Loading label="Finding deals" /> : null}

      {data && shown.length === 0 ? (
        <Empty look="scout-shrug" title="No deals here yet" line="Pull down to check again, or try another category." />
      ) : null}

      {shown.length > 0 ? (
        <Section kicker="Near you" title={cat ? catLabel(cat) : "All finds"}>
          {shown.map((d) => (
            <DealRow key={d.sku} deal={d} onPress={() => router.push({ pathname: "/deal/[sku]", params: { sku: d.sku } })} />
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  heroFigure: { backgroundColor: "rgba(255,255,255,0.65)" },
  chips: { gap: space.s, paddingRight: space.l },
  chip: { borderWidth: 1.5, borderColor: colours.ink, borderRadius: radius.pill, paddingHorizontal: 16, paddingVertical: 8 },
  chipOn: { backgroundColor: colours.ink },
  chipText: { fontFamily: fonts.textBold, fontSize: 14.5, color: colours.ink },
  chipTextOn: { color: colours.canvas },
});
