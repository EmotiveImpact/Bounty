import { router, useLocalSearchParams } from "expo-router";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "@/lib/api";
import { money } from "@/lib/format";
import type { Deal } from "@/lib/types";
import { useLoad } from "@/lib/use-load";
import { ItemPhoto, VERDICT, priceLine } from "@/ui/deal-parts";
import { Icon } from "@/ui/icons";
import { Button, Card, Figure, Figures, Loading, Notice, Problem, Row, SampleTag, Small, Tag, Title, Txt } from "@/ui/kit";
import { colours, radius, space } from "@/ui/theme";

// One deal in full: the answer, the money, and why.

export default function DealScreen() {
  const { sku } = useLocalSearchParams<{ sku: string }>();
  const insets = useSafeAreaInsets();
  const { data, error, reload } = useLoad(() => api<{ deals: Deal[] }>("deals"), sku);
  const deal = data?.deals.find((d) => d.sku === sku) ?? null;
  const v = deal ? (VERDICT[deal.verdict] ?? VERDICT.unknown) : null;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.bar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10} style={styles.back}>
          <Icon name="back" />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.page}>
        {error ? <Problem message={error} onRetry={reload} /> : null}
        {!data && !error ? <Loading /> : null}
        {data && !deal ? <Notice>This deal has gone. Pull down on Deals to see what is live now.</Notice> : null}
        {deal && v ? (
          <>
            <View style={{ alignItems: "center" }}>
              <ItemPhoto deal={deal} size={240} />
            </View>
            <View style={{ gap: space.s }}>
              <View style={{ flexDirection: "row", gap: space.s, flexWrap: "wrap" }}>
                <Tag label={v.label} tint={v.tint} />
                {deal.sample ? <SampleTag /> : null}
              </View>
              <Title size={30}>{deal.name}</Title>
              {deal.variant ? <Txt style={{ color: colours.inkSoft }}>{deal.variant}</Txt> : null}
              <Txt>{deal.reason}</Txt>
            </View>

            <Figures>
              <Figure value={money(deal.buy)} label="You pay" />
              <Figure value={deal.salePrice === null ? "not known" : money(deal.salePrice)} label="It sells for" />
              <Figure
                value={money(deal.unitProfit)}
                label={deal.unitProfit !== null && deal.unitProfit < 0 ? "You lose a unit" : "You keep a unit"}
                style={{ backgroundColor: colours.lime }}
              />
              <Figure value={money(deal.walkAway)} label="Walk away if the shelf price is above" />
            </Figures>

            <Card>
              <Title size={20}>Where</Title>
              <Row label="Shop" value={deal.shop + (deal.area ? `, ${deal.area}` : "")} />
              {deal.miles !== null ? <Row label="Distance" value={`${deal.miles} miles`} /> : null}
              {deal.stock !== null ? <Row label="On the shelf" value={`${deal.stock}`} /> : null}
              {priceLine(deal) ? <Small>{priceLine(deal)}</Small> : null}
              <Small>Travel costs are shown with each trip and never hide a find.</Small>
            </Card>

            {deal.costs ? (
              <Card>
                <Title size={20}>What comes off</Title>
                <Row label="Selling fees" value={money(deal.costs.fees)} />
                <Row label="Postage" value={money(deal.costs.postage)} />
                <Row label="Packaging" value={money(deal.costs.packaging)} />
                <Row label="Returns allowance" value={money(deal.costs.returns)} />
              </Card>
            ) : null}

            {deal.sales.length > 0 ? (
              <Card>
                <Title size={20}>Recent completed sales</Title>
                <View style={styles.sales}>
                  {deal.sales.map((p, i) => (
                    <View key={i} style={styles.sale}>
                      <Txt>{money(p)}</Txt>
                    </View>
                  ))}
                </View>
                {deal.salesPerWeek !== null ? <Small>About {deal.salesPerWeek} sold a week.</Small> : null}
                {deal.competingListings !== null ? <Small>{deal.competingListings} other sellers listed.</Small> : null}
              </Card>
            ) : null}

            {deal.notes.length > 0 || deal.storageNeeds ? (
              <Card>
                <Title size={20}>Worth knowing</Title>
                {deal.notes.map((n) => (
                  <Txt key={n}>• {n}</Txt>
                ))}
                {deal.storageNeeds ? <Txt>• {deal.storageNeeds}</Txt> : null}
              </Card>
            ) : null}

            <Button
              label="I bought this: add to Stock"
              onPress={() =>
                router.push({ pathname: "/add-stock", params: { item: deal.name, price: (deal.buy / 100).toFixed(2), shop: deal.shop, sample: String(deal.sample === true) } })
              }
            />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colours.canvas },
  bar: { height: 52, justifyContent: "center", paddingHorizontal: space.m },
  back: { width: 40, height: 40, borderRadius: 20, backgroundColor: colours.panel, alignItems: "center", justifyContent: "center" },
  page: { padding: space.l, paddingBottom: 48, gap: space.xl },
  sales: { flexDirection: "row", flexWrap: "wrap", gap: space.s },
  sale: { backgroundColor: colours.panel, borderRadius: radius.s, paddingHorizontal: 12, paddingVertical: 6 },
});
