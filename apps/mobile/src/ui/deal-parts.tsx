import { Image } from "expo-image";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { siteFile } from "@/lib/api";
import { money } from "@/lib/format";
import type { Deal, Verdict } from "@/lib/types";
import { Icon } from "./icons";
import { Card, SampleTag, Small, Strong, Tag, Txt } from "./kit";
import { colours, radius, space } from "./theme";

export const VERDICT: Record<Verdict, { label: string; tint: string }> = {
  buy: { label: "Buy", tint: colours.lime },
  think: { label: "Think", tint: colours.butter },
  leave: { label: "Leave", tint: colours.candy },
  unknown: { label: "Not sure", tint: colours.panel },
};

const CATEGORY_TINT: Record<string, string> = {
  tech: colours.sky,
  toys: colours.butter,
  clothing: colours.peach,
  beauty: colours.candy,
  general: colours.pistachio,
};

/** The product photo the website has, or a drawn tile when there is none. */
export function ItemPhoto({ deal, size }: { deal: Pick<Deal, "sku" | "category">; size: number }) {
  const [failed, setFailed] = useState(false);
  const frame = { width: size, height: size, borderRadius: radius.m, overflow: "hidden" as const };
  if (failed)
    return (
      <View style={[frame, styles.tile, { backgroundColor: CATEGORY_TINT[deal.category] ?? colours.lilac }]}>
        <Icon name={deal.category} size={size * 0.42} weight={1.6} />
      </View>
    );
  return (
    <View style={[frame, { backgroundColor: colours.panel }]}>
      <Image
        source={{ uri: siteFile(`products/${encodeURIComponent(deal.sku)}.jpg`) }}
        style={{ flex: 1 }}
        contentFit="cover"
        transition={150}
        onError={() => setFailed(true)}
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}

/** Where the price came from: the shop's website, or a shelf find. */
export function priceLine(d: Deal) {
  return d.priceSource === "shelf" ? "Shelf price spotted in the shop" : d.priceSource === "online" ? "Price from the shop's website" : "";
}

/** A deal in a list: photo, name, what you pay, what it sells for, what you keep. */
export function DealRow({ deal, onPress }: { deal: Deal; onPress: () => void }) {
  const v = VERDICT[deal.verdict] ?? VERDICT.unknown;
  const losing = deal.unitProfit !== null && deal.unitProfit < 0;
  return (
    <Card onPress={onPress} label={`${deal.name}, ${v.label}`} style={styles.row}>
      <View>
        <ItemPhoto deal={deal} size={92} />
        {deal.underSale !== null ? (
          <View style={styles.badge}>
            <Small style={styles.badgeText}>−{deal.underSale}%</Small>
          </View>
        ) : null}
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <Strong numberOfLines={2}>{deal.name}</Strong>
        <Txt>
          <Strong>{money(deal.buy)}</Strong> · sells {deal.salePrice === null ? "not known" : money(deal.salePrice)}
        </Txt>
        <Txt style={{ color: losing ? colours.warn : colours.brand }}>
          <Strong style={{ color: losing ? colours.warn : colours.brand }}>
            {losing ? "Lose" : "Keep"} {money(Math.abs(deal.unitProfit ?? 0))}
          </Strong>{" "}
          a unit
        </Txt>
        <Small numberOfLines={1}>
          {deal.shop}
          {deal.area ? `, ${deal.area}` : ""}
          {deal.miles !== null ? ` · ${deal.miles} mi` : ""}
        </Small>
        <View style={{ flexDirection: "row", gap: space.s, flexWrap: "wrap", marginTop: 2 }}>
          <Tag label={v.label} tint={v.tint} />
          {deal.sample ? <SampleTag /> : null}
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: space.m, alignItems: "flex-start" },
  tile: { alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", top: 6, left: 6, backgroundColor: colours.badge, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 },
  badgeText: { color: colours.ink, fontWeight: "700" },
});
