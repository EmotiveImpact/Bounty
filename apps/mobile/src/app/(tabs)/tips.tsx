import { View } from "react-native";
import { api } from "@/lib/api";
import { barcodeText, dateTime } from "@/lib/format";
import type { Tip } from "@/lib/types";
import { useLoad } from "@/lib/use-load";
import { Card, Empty, Hero, Loading, Notice, Problem, SampleTag, Screen, Section, Small, Strong, Tag, Title, Txt } from "@/ui/kit";
import { colours, space, tabTint } from "@/ui/theme";

// Tips: shelf finds members have spotted in shops near you. Every tip is
// buy and resell: you buy and own the stock. A tip never pays a reward.

export default function TipsScreen() {
  const { data, error, refreshing, refresh, reload } = useLoad(() => api<{ bounties: Tip[] }>("bounties"));
  const tips = (data?.bounties ?? []).filter((t) => t.status === "open");
  const sample = tips.some((t) => t.sample);

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Hero tint={tabTint.tips} kicker="Spotted by members" title="Tips near you." lead="Shelf finds from people in your area, with how many places are left." />

      {sample ? <Notice>These tips are samples with made-up figures, for practice only. There is nothing to claim or buy.</Notice> : null}
      {error && !data ? <Problem message={error} onRetry={reload} /> : null}
      {!data && !error ? <Loading label="Loading tips" /> : null}
      {data && tips.length === 0 ? (
        <Empty look="insider-shush" title="No tips open right now" line="When a member spots a find near you, it shows here." />
      ) : null}

      {tips.length > 0 ? (
        <Section kicker="Open now" title={`${tips.length} ${tips.length === 1 ? "tip" : "tips"}`}>
          {tips.map((t) => (
            <Card key={t.id}>
              <View style={{ flexDirection: "row", gap: space.s, flexWrap: "wrap" }}>
                <Tag label={t.trip.label} tint={t.trip.go ? colours.lime : colours.panel} />
                {t.sample && !/^sample/i.test(t.trip.label) ? <SampleTag /> : null}
              </View>
              <Title size={21}>{t.title}</Title>
              {t.variant ? <Small>{t.variant}</Small> : null}
              <Txt>
                {t.retailer ? `${t.retailer}, ` : ""}
                {t.locality}
              </Txt>
              <Txt>
                <Strong>
                  {t.remaining} of {t.cap}
                </Strong>{" "}
                places left
              </Txt>
              {t.reports.positive > 0 ? (
                <Small>
                  Confirmed on the shelf by {t.reports.positive} {t.reports.positive === 1 ? "member" : "members"}
                </Small>
              ) : null}
              {t.mainUncertainty ? <Small>Main doubt: {t.mainUncertainty}</Small> : null}
              {t.barcode ? <Small>Barcode {barcodeText(t.barcode)}</Small> : null}
              {t.expiresAt ? <Small>Open until {dateTime(t.expiresAt)}</Small> : null}
            </Card>
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}
