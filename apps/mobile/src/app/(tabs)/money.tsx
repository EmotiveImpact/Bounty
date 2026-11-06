import { router, useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { StyleSheet, View } from "react-native";
import { api } from "@/lib/api";
import { money } from "@/lib/format";
import type { Goals, Summary } from "@/lib/types";
import { useLoad } from "@/lib/use-load";
import { Button, Card, CrewArt, Empty, Figure, Figures, Hero, Loading, Problem, Screen, Small, Strong, Title, Txt } from "@/ui/kit";
import { colours, radius, space, tabTint } from "@/ui/theme";

// Money: what you kept this month, what is on its way, and the cash still
// sitting in unsold stock. The same sums as the website's Money.

const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const monthName = (m: string) => {
  const ms = Date.parse(m + "-15T12:00:00Z");
  return Number.isFinite(ms) ? MONTH.format(new Date(ms)) : m;
};

export default function MoneyScreen() {
  const { data, error, refreshing, refresh, reload } = useLoad(() =>
    Promise.all([api<Summary>("ledger/summary"), api<Goals>("goals")]).then(([summary, goals]) => ({ summary, goals })),
  );
  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  const now = data?.summary;
  const savings = data?.goals.targetType === "savings";
  const kept = now ? (savings ? now.householdSavings : now.realisedEarnings) : 0;
  const target = data?.goals.monthlyTarget ?? 0;
  const share = target > 0 ? Math.min(1, Math.max(0, kept) / target) : 0;
  const empty = !!now && !now.realisedEarnings && !now.pendingPayouts && !now.cashTiedUp && !now.openTrips && !now.householdSavings;

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Hero tint={tabTint.money} kicker={now ? monthName(now.month) : "This month"} title={now ? money(kept) : "Your money."} lead={savings ? "Saved this month on things for home." : kept < 0 ? "Spent on stock this month, more than has come back so far." : "Kept this month after costs."}>
        {target > 0 ? (
          <View style={{ gap: 6, marginTop: space.s }}>
            <View style={styles.meter}>
              <View style={[styles.meterFill, { width: `${Math.round(share * 100)}%` }]} />
            </View>
            <Small style={{ color: colours.ink }}>
              {money(Math.max(0, kept))} of your {money(target)} monthly target
            </Small>
          </View>
        ) : null}
      </Hero>

      {error && !data ? <Problem message={error} onRetry={reload} /> : null}
      {!data && !error ? <Loading label="Adding it up" /> : null}

      {empty ? (
        <Empty look="negotiator-receipt" title="Nothing counted yet this month" line="Add what you buy in Stock and your money shows up here.">
          <Button kind="ghost" label="Go to Stock" onPress={() => router.navigate("/stock")} />
        </Empty>
      ) : null}

      {now && !empty ? (
        <>
          <Figures>
            <Figure value={money(now.pendingPayouts)} label="On its way to you" />
            <Figure value={money(now.cashTiedUp ?? 0)} label="Cash in unsold stock" />
            <Figure value={String(now.unsoldUnits ?? 0)} label="Items still to sell" />
            <Figure value={now.realisedHourly == null ? "Not known" : money(now.realisedHourly)} label="An hour, on trips with time logged" />
          </Figures>
          {now.householdSavings && !savings ? (
            <Card>
              <Txt>
                You also saved <Strong>{money(now.householdSavings)}</Strong> on things for home.
              </Txt>
            </Card>
          ) : null}
          <View style={{ alignItems: "center" }}>
            <CrewArt look="negotiator-receipt" height={200} />
          </View>
        </>
      ) : null}

      {now ? (
        <Card>
          <Title size={18}>How this is counted</Title>
          <Small>Money paid out to you this month, less what you spent this month. Open trips show what is on its way and the cash still in stock.</Small>
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  meter: { height: 12, borderRadius: radius.pill, backgroundColor: "rgba(255,255,255,0.7)", overflow: "hidden" },
  meterFill: { height: 12, borderRadius: radius.pill, backgroundColor: colours.ink },
});
