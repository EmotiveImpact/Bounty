import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SignInNeeded, api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { money, poundsText, todayUk } from "@/lib/format";
import { Icon } from "@/ui/icons";
import { Button, Field, Notice, Small, Title, Txt } from "@/ui/kit";
import { colours, space } from "@/ui/theme";

// Add a purchase to Stock: a new trip with one receipt on it, the same way
// the website records a trip. Opens filled in from a deal or a scan.

export default function AddStock() {
  const params = useLocalSearchParams<{ item?: string; price?: string; shop?: string }>();
  const insets = useSafeAreaInsets();
  const { refresh } = useAuth();
  const [item, setItem] = useState(params.item ?? "");
  const [shop, setShop] = useState(params.shop ?? "");
  const [units, setUnits] = useState("1");
  const [price, setPrice] = useState(params.price ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const each = poundsText(price);
  const count = /^\d{1,4}$/.test(units.trim()) ? Number(units.trim()) : 0;

  async function save() {
    setError("");
    if (!item.trim()) return setError("Say what you bought.");
    if (count < 1) return setError("Enter how many you bought, as a whole number.");
    if (each === null) return setError("Enter the price for one, in pounds, for example 4.50");
    setBusy(true);
    try {
      const date = todayUk();
      const { id } = await api<{ id: number }>("ledger/trips", {
        label: `Trip ${date}${shop.trim() ? " · " + shop.trim() : ""}`.slice(0, 120),
        source: "manual",
        kind: "resale",
      });
      await api("ledger/trips/" + id + "/entries", {
        type: "receipt",
        amount: count * each,
        units: count,
        reference: item.trim().slice(0, 120),
        occurred: date,
        note: `Added from the Bounty phone app${shop.trim() ? ". Bought at " + shop.trim() : ""}.`,
      });
      router.back();
    } catch (e) {
      // Signed out somewhere else: checking again takes the app back to sign-in.
      if (e instanceof SignInNeeded) return refresh();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={[styles.screen, { paddingTop: Platform.OS === "ios" ? 0 : insets.top }]}>
      <View style={styles.bar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => router.back()} hitSlop={10} style={styles.close}>
          <Icon name="close" size={20} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <Title size={30}>Add a purchase</Title>
        <Txt style={{ color: colours.inkSoft }}>It goes into Stock as a new trip, so you can see what is left to sell.</Txt>
        <Field label="What you bought" value={item} onChangeText={setItem} placeholder="For example Wireless headphones" maxLength={120} />
        <Field label="Shop" value={shop} onChangeText={setShop} placeholder="For example Tesco" maxLength={60} />
        <View style={{ flexDirection: "row", gap: space.m }}>
          <View style={{ flex: 1 }}>
            <Field label="How many" value={units} onChangeText={setUnits} keyboardType="number-pad" maxLength={4} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Price for one" value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="£" />
          </View>
        </View>
        {each !== null && count > 0 ? <Small>That is {money(each * count)} in all.</Small> : null}
        {error ? <Notice tone="warn">{error}</Notice> : null}
        <Button label="Save to Stock" busy={busy} onPress={save} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colours.canvas },
  bar: { height: 56, justifyContent: "center", alignItems: "flex-end", paddingHorizontal: space.m },
  close: { width: 40, height: 40, borderRadius: 20, backgroundColor: colours.panel, alignItems: "center", justifyContent: "center" },
  page: { padding: space.l, paddingBottom: 48, gap: space.l },
});
