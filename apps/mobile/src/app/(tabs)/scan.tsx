import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { router, useIsFocused } from "expo-router";
import { useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { api } from "@/lib/api";
import { barcodeText, money, poundsText } from "@/lib/format";
import type { Deal, ScanResult } from "@/lib/types";
import { useLoad } from "@/lib/use-load";
import { VERDICT } from "@/ui/deal-parts";
import { Button, Card, CrewArt, Field, Figure, Figures, Hero, Notice, SampleTag, Screen, Small, Tag, Title, Txt } from "@/ui/kit";
import { colours, fonts, radius, space, tabTint } from "@/ui/theme";

// Scan in the shop: point the camera at a barcode (or type it), add the
// sticker price, and get a straight answer from completed sales: buy, think
// or leave. A barcode Bounty has no sales for is answered as not known,
// never guessed.

export default function ScanScreen() {
  const focused = useIsFocused();
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraOn, setCameraOn] = useState(false);
  const [code, setCode] = useState("");
  const [price, setPrice] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lastRead = useRef("");
  const samples = useLoad(() => api<{ deals: Deal[] }>("deals").then((r) => r.deals.filter((d) => d.sample).slice(0, 4)));

  async function check(target: { sku?: string; barcode?: string }) {
    setError("");
    const typed = price.trim();
    const shelf = poundsText(typed);
    if (typed && shelf === null) return setError("Enter the sticker price in pounds, for example 4.50");
    setBusy(true);
    try {
      setResult(await api<ScanResult>("scan", { ...target, price: shelf ?? undefined }));
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onRead(scan: BarcodeScanningResult) {
    const value = scan.data?.trim();
    if (!value || value === lastRead.current) return;
    lastRead.current = value;
    setCode(value);
    setCameraOn(false);
    setResult(null);
  }

  async function openCamera() {
    lastRead.current = "";
    if (permission?.granted) return setCameraOn(true);
    const answer = await requestPermission();
    if (answer.granted) setCameraOn(true);
  }

  const blocked = permission && !permission.granted && !permission.canAskAgain;

  return (
    <Screen>
      <Hero tint={tabTint.scan} kicker="In the shop" title="Scan it." lead="Scan the barcode, add the sticker price, and get a straight answer: buy, think or leave." />

      {cameraOn && focused ? (
        <View style={styles.cameraFrame}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e"] }}
            onBarcodeScanned={onRead}
          />
          <View style={styles.aim} pointerEvents="none" />
          <Pressable accessibilityRole="button" onPress={() => setCameraOn(false)} style={styles.cameraClose}>
            <Text style={styles.cameraCloseText}>Close camera</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.startRow}>
          <CrewArt look="scout-lookout" height={150} />
          <View style={{ flex: 1, gap: space.s }}>
            <Button label="Scan a barcode" onPress={openCamera} />
            {blocked ? (
              <>
                <Small>Bounty is not allowed to use the camera. You can turn it on in Settings, or type the barcode below.</Small>
                <Button small kind="ghost" label="Open Settings" onPress={() => Linking.openSettings()} />
              </>
            ) : (
              <Small>Or type the numbers under the barcode.</Small>
            )}
          </View>
        </View>
      )}

      <View style={{ gap: space.l }}>
        <Field
          label="Barcode"
          value={code}
          onChangeText={(t) => (setCode(t.replace(/\D/g, "")), setResult(null))}
          keyboardType="number-pad"
          placeholder="For example 5012345678900"
          maxLength={14}
        />
        <Field
          label="Sticker price"
          value={price}
          onChangeText={(t) => (setPrice(t), setResult(null))}
          keyboardType="decimal-pad"
          placeholder="£"
          hint="Leave it empty to use the price Bounty already has."
        />
        {error ? <Notice tone="warn">{error}</Notice> : null}
        <Button label="Check it" busy={busy} disabled={!code} onPress={() => check({ barcode: code })} />
      </View>

      {result ? <Answer result={result} /> : null}

      {samples.data && samples.data.length > 0 && !result ? (
        <Card>
          <Title size={18}>No barcode to hand?</Title>
          <Small>Try one of the sample items. Their figures are made up.</Small>
          <View style={styles.sampleRow}>
            {samples.data.map((d) => (
              <Pressable key={d.sku} accessibilityRole="button" onPress={() => check({ sku: d.sku })} style={styles.sampleChip}>
                <Text style={styles.sampleText}>{d.name}</Text>
              </Pressable>
            ))}
          </View>
        </Card>
      ) : null}
    </Screen>
  );
}

function Answer({ result }: { result: ScanResult }) {
  if (!result.found) {
    const v = VERDICT[result.verdict] ?? VERDICT.unknown;
    return (
      <Card style={{ backgroundColor: v.tint, borderColor: v.tint }}>
        <Title size={26}>{v.label}</Title>
        <Txt>{result.reason}</Txt>
        {result.barcode ? <Small>Barcode {barcodeText(result.barcode)}</Small> : null}
      </Card>
    );
  }
  const d = result.deal;
  const v = VERDICT[d.verdict] ?? VERDICT.unknown;
  return (
    <Card style={{ borderColor: v.tint, borderWidth: 3, gap: space.m }}>
      <View style={{ flexDirection: "row", gap: space.s, flexWrap: "wrap" }}>
        <Tag label={v.label} tint={v.tint} />
        {d.sample ? <SampleTag /> : null}
      </View>
      <Title size={26}>{d.name}</Title>
      <Txt>{d.reason}</Txt>
      <Figures>
        <Figure value={money(result.shelfPrice)} label="On the sticker" />
        <Figure value={money(d.unitProfit)} label="You keep a unit" style={{ backgroundColor: colours.lime }} />
        <Figure value={money(d.walkAway)} label="Walk away above" />
        <Figure value={d.salePrice === null ? "not known" : money(d.salePrice)} label="It sells for" />
      </Figures>
      <Button
        kind="ghost"
        label="I bought it: add to Stock"
        onPress={() => router.push({ pathname: "/add-stock", params: { item: d.name, price: (result.shelfPrice / 100).toFixed(2), shop: d.shop, sample: String(d.sample === true) } })}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  cameraFrame: { height: 320, borderRadius: radius.l, overflow: "hidden", backgroundColor: "#000" },
  aim: {
    position: "absolute",
    left: "12%",
    right: "12%",
    top: "35%",
    height: "30%",
    borderWidth: 3,
    borderColor: colours.periwinkle,
    borderRadius: radius.m,
  },
  cameraClose: {
    position: "absolute",
    bottom: space.m,
    alignSelf: "center",
    backgroundColor: colours.canvas,
    borderRadius: radius.pill,
    paddingHorizontal: space.l,
    paddingVertical: space.s,
  },
  cameraCloseText: { fontFamily: fonts.textBold, fontSize: 15, color: colours.ink },
  startRow: { flexDirection: "row", alignItems: "center", gap: space.l },
  sampleRow: { flexDirection: "row", flexWrap: "wrap", gap: space.s, marginTop: space.xs },
  sampleChip: { backgroundColor: colours.periwinkle, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
  sampleText: { fontFamily: fonts.textBold, fontSize: 14, color: colours.ink },
});
