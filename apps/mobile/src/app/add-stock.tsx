import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
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
  const params = useLocalSearchParams<{ item?: string; price?: string; shop?: string; sample?: string }>();
  const insets = useSafeAreaInsets();
  const { refresh } = useAuth();
  const [item, setItem] = useState(params.item ?? "");
  const [shop, setShop] = useState(params.shop ?? "");
  const [units, setUnits] = useState("1");
  const [occurred] = useState(todayUk);
  const sample = params.sample === "true";
  const [price, setPrice] = useState(sample ? "" : params.price ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const saving = useRef(false);
  const attempt = useRef<{ payload: string; requestId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const each = poundsText(price);
  const count = /^\d{1,4}$/.test(units.trim()) ? Number(units.trim()) : 0;

  async function save() {
    if (saving.current) return;
    setError("");
    if (!item.trim()) return setError("Say what you bought.");
    if (count < 1) return setError("Enter how many you bought, as a whole number.");
    if (each === null) return setError("Enter the price for one, in pounds, for example 4.50");
    if (!confirmed) return setError("Confirm you bought this item and the price is what you actually paid.");
    saving.current = true;
    setBusy(true);
    try {
      const date = occurred;
      const purchase = {
        item: item.trim(), shop: shop.trim(), units: count, unitPrice: each,
        occurred: date, sourceSample: sample, actualConfirmed: true,
      };
      const payload = JSON.stringify(purchase);
      // Retain the identifier on a network failure. A retry cannot add it twice.
      if (attempt.current?.payload !== payload) attempt.current = {
        payload, requestId: `purchase_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`,
      };
      await api("ledger/purchases", { ...purchase, requestId: attempt.current.requestId });
      router.back();
    } catch (e) {
      // Signed out somewhere else: checking again takes the app back to sign-in.
      if (e instanceof SignInNeeded) return refresh();
      setError((e as Error).message);
    } finally {
      saving.current = false;
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
        {sample ? <Notice tone="warn">This came from a sample with made-up figures. Enter the actual price from your purchase.</Notice> : null}
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
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: confirmed }} onPress={() => setConfirmed(!confirmed)}>
          <Txt>{confirmed ? "☑" : "☐"} I bought this item and entered the price I actually paid.</Txt>
        </Pressable>
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
