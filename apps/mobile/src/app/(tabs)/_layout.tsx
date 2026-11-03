import { Tabs, type BottomTabBarProps } from "expo-router/js-tabs";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/ui/icons";
import { colours, fonts, tabTint, type TabName } from "@/ui/theme";

// The phone bar agreed for Bounty: Deals, Tips, Scan, Stock, Money. The tab
// you are on sits in its own bright tint.

const TABS: { name: string; tab: TabName; label: string }[] = [
  { name: "deals", tab: "deals", label: "Deals" },
  { name: "tips", tab: "tips", label: "Tips" },
  { name: "scan", tab: "scan", label: "Scan" },
  { name: "stock", tab: "stock", label: "Stock" },
  { name: "money", tab: "money", label: "Money" },
];

function PhoneBar({ state, navigateToTab }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      {state.routes.map((route, index) => {
        const tab = TABS.find((t) => t.name === route.name);
        if (!tab) return null;
        const on = state.index === index;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={tab.label}
            onPress={() => {
              if (!on) navigateToTab(route.key);
            }}
            style={styles.item}
          >
            <View style={[styles.pill, on && { backgroundColor: tabTint[tab.tab] }]}>
              <Icon name={tab.tab} size={22} weight={on ? 2.2 : 1.8} colour={on ? colours.ink : colours.inkSoft} />
            </View>
            <Text style={[styles.label, on && styles.labelOn]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function TabLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <PhoneBar {...props} />}>
      {TABS.map((t) => (
        <Tabs.Screen key={t.name} name={t.name} options={{ title: t.label }} />
      ))}
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    backgroundColor: colours.canvas,
    borderTopWidth: 1,
    borderTopColor: colours.line,
    paddingTop: 8,
  },
  item: { flex: 1, alignItems: "center", gap: 3 },
  pill: { width: 56, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  label: { fontFamily: fonts.textMedium, fontSize: 12, color: colours.inkSoft },
  labelOn: { fontFamily: fonts.textBold, color: colours.ink },
});
