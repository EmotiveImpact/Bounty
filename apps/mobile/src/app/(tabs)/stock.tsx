import { router, useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { View } from "react-native";
import { api } from "@/lib/api";
import { dateTime, money } from "@/lib/format";
import type { TripRow } from "@/lib/types";
import { useLoad } from "@/lib/use-load";
import { Button, Card, Empty, Hero, Loading, Problem, SampleTag, Screen, Section, Small, Tag, Title, Txt } from "@/ui/kit";
import { colours, space, tabTint } from "@/ui/theme";

// Stock: what you bought on each trip, what is still unsold and what is
// waiting to be paid out. The same records as the website's Stock.

export default function StockScreen() {
  const { data, error, refreshing, refresh, reload } = useLoad(() => api<{ trips: TripRow[] }>("ledger/trips"));
  // Come back from adding a purchase to a fresh list.
  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );
  const trips = (data?.trips ?? []).slice().sort((a, b) => Number(a.status === "closed") - Number(b.status === "closed") || b.id - a.id);
  const open = trips.filter((t) => t.status === "open");

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Hero tint={tabTint.stock} kicker="Your stock" title="What you’ve got." lead="Every trip you buy on, what is still to sell and what is on its way to you.">
        <Button label="Add a purchase" onPress={() => router.push("/add-stock")} style={{ marginTop: space.s, alignSelf: "flex-start" }} />
      </Hero>

      {error && !data ? <Problem message={error} onRetry={reload} /> : null}
      {!data && !error ? <Loading label="Loading your stock" /> : null}
      {data && trips.length === 0 ? (
        <Empty look="fixer-handover" title="Nothing in stock yet" line="Add what you buy and Bounty keeps count of what is left to sell." />
      ) : null}

      {trips.length > 0 ? (
        <Section kicker={`${open.length} open`} title="Trips">
          {trips.map((t) => (
            <Card key={t.id}>
              <View style={{ flexDirection: "row", gap: space.s, flexWrap: "wrap" }}>
                <Tag label={t.status === "open" ? "Open" : "Finished"} tint={t.status === "open" ? colours.peach : colours.panel} />
                {t.kind === "household" ? <Tag label="For home" tint={colours.pistachio} /> : null}
                {t.sample ? <SampleTag /> : null}
              </View>
              <Title size={19}>{t.label}</Title>
              <Small>Started {dateTime(t.created)}</Small>
              {t.unsoldUnits !== null && t.unsoldUnits > 0 ? <Txt>{t.unsoldUnits} still to sell</Txt> : null}
              {t.pendingPayout > 0 ? <Txt>{money(t.pendingPayout)} waiting to be paid out</Txt> : null}
              {t.status === "closed" && t.realisedContribution !== null ? (
                <Txt style={{ color: t.realisedContribution < 0 ? colours.warn : colours.brand }}>
                  {t.realisedContribution < 0 ? "Lost " : "Made "}
                  {money(Math.abs(t.realisedContribution))}
                </Txt>
              ) : null}
            </Card>
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}
