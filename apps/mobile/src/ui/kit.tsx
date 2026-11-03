import { Image } from "expo-image";
import { router } from "expo-router";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/lib/auth";
import { Icon } from "./icons";
import { colours, fonts, radius, space } from "./theme";

// The app's building blocks, matching the website's kit (src/ui/kit.tsx):
// build every screen from these so the look stays one look.

// ---------- text ----------

export function Txt({ style, ...rest }: TextProps) {
  return <Text style={[s.text, style]} {...rest} />;
}
export function Strong({ style, ...rest }: TextProps) {
  return <Text style={[s.text, s.strong, style]} {...rest} />;
}
export function Small({ style, ...rest }: TextProps) {
  return <Text style={[s.text, s.small, style]} {...rest} />;
}
export function Kicker({ style, ...rest }: TextProps) {
  return <Text style={[s.kicker, style]} {...rest} />;
}
/** A Cal Sans heading. */
export function Title({ size = 28, style, ...rest }: TextProps & { size?: number }) {
  return <Text accessibilityRole="header" style={[s.title, { fontSize: size, lineHeight: Math.round(size * 1.12) }, style]} {...rest} />;
}

// ---------- the logo ----------

/** The logo in every slot. One place to change when the new logo arrives. */
export function Wordmark() {
  return (
    <View accessible accessibilityLabel="Bounty London" style={s.word}>
      <Text style={s.wordBig}>BOUNTY</Text>
      <Text style={s.wordSmall}>LONDON</Text>
    </View>
  );
}

// ---------- the top bar ----------

/**
 * Logo on the left. Signed out: Sign in and Sign up. Signed in: only the
 * member's round picture with a down arrow, which opens their account.
 */
export function TopBar() {
  const { user, checking } = useAuth();
  const initial = (user?.name || user?.email || "?").trim().charAt(0).toUpperCase();
  return (
    <View style={s.topbar}>
      <Wordmark />
      {checking ? null : user ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Your account"
          onPress={() => router.push("/account")}
          style={s.avatarBtn}
          hitSlop={8}
        >
          <View style={s.avatar}>
            <Text style={s.avatarText}>{initial}</Text>
          </View>
          <Icon name="down" size={16} />
        </Pressable>
      ) : (
        <View style={s.row}>
          <Button small kind="ghost" label="Sign in" onPress={() => router.push("/sign-in")} />
          <Button small label="Sign up" onPress={() => router.push({ pathname: "/sign-in", params: { mode: "up" } })} />
        </View>
      )}
    </View>
  );
}

// ---------- screens ----------

/** A tab screen: top bar, then a scrolling page with pull to refresh. */
export function Screen({
  children,
  refreshing,
  onRefresh,
  scroll = true,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  scroll?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <TopBar />
      {scroll ? (
        <ScrollView
          contentContainerStyle={s.page}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[s.page, { flex: 1 }]}>{children}</View>
      )}
    </View>
  );
}

/** The bright block at the top of each tab: its tint, a heading and a line. */
export function Hero({ tint, title, lead, kicker, children }: { tint: string; title: string; lead?: string; kicker?: string; children?: ReactNode }) {
  return (
    <View style={[s.hero, { backgroundColor: tint }]}>
      {kicker ? <Kicker>{kicker}</Kicker> : null}
      <Title size={34}>{title}</Title>
      {lead ? <Txt style={s.lead}>{lead}</Txt> : null}
      {children}
    </View>
  );
}

export function Section({ title, kicker, children, style }: { title?: string; kicker?: string; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[s.section, style]}>
      {kicker ? <Kicker>{kicker}</Kicker> : null}
      {title ? <Title size={22}>{title}</Title> : null}
      <View style={{ gap: space.m, marginTop: title || kicker ? space.m : 0 }}>{children}</View>
    </View>
  );
}

export function Card({ children, style, onPress, label }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; label?: string }) {
  if (!onPress) return <View style={[s.card, style]}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [s.card, pressed && s.pressed, style]}
    >
      {children}
    </Pressable>
  );
}

// ---------- buttons ----------

export function Button({
  label,
  onPress,
  kind = "main",
  tint,
  small,
  busy,
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  kind?: "main" | "ghost" | "tint";
  tint?: string;
  small?: boolean;
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const off = disabled || busy;
  const bg = kind === "main" ? colours.ink : kind === "tint" ? (tint ?? colours.lime) : "transparent";
  const fg = kind === "main" ? colours.canvas : colours.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        s.btn,
        small && s.btnSmall,
        { backgroundColor: bg },
        kind === "ghost" && s.btnGhost,
        pressed && s.pressed,
        off && { opacity: 0.5 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[s.btnText, small && s.btnTextSmall, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

// ---------- small parts ----------

/** A rounded label, for example the verdict or "Sample". */
export function Tag({ label, tint = colours.panel, style }: { label: string; tint?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[s.tag, { backgroundColor: tint }, style]}>
      <Text style={s.tagText}>{label}</Text>
    </View>
  );
}

/** Every made-up figure carries this, so nothing invented passes for real. */
export function SampleTag() {
  return <Tag label="Sample figures" tint={colours.lemon} />;
}

/** One big figure with what it means under it. */
export function Figure({ value, label, style }: { value: string; label: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[s.figure, style]}>
      <Text style={s.figureValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Small>{label}</Small>
    </View>
  );
}
export function Figures({ children }: { children: ReactNode }) {
  return <View style={s.figures}>{children}</View>;
}

/** A label on the left, its value on the right. */
export function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={s.rowLine}>
      <Txt style={{ flex: 1, color: colours.inkSoft }}>{label}</Txt>
      <Txt style={strong ? s.strong : undefined}>{value}</Txt>
    </View>
  );
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <View style={[s.notice, tone === "warn" && { backgroundColor: "#fdecea" }]}>
      <Txt style={tone === "warn" ? { color: colours.warn } : undefined}>{children}</Txt>
    </View>
  );
}

// ---------- crew pictures ----------

const CREW = {
  "crew-group": require("@/assets/crew/crew-group.jpg"),
  "negotiator-deal": require("@/assets/crew/negotiator-deal.jpg"),
  "scout-lookout": require("@/assets/crew/scout-lookout.jpg"),
  "insider-shush": require("@/assets/crew/insider-shush.jpg"),
  "fixer-handover": require("@/assets/crew/fixer-handover.jpg"),
  "negotiator-receipt": require("@/assets/crew/negotiator-receipt.jpg"),
  "scout-shrug": require("@/assets/crew/scout-shrug.jpg"),
} as const;
export type CrewLook = keyof typeof CREW;

/**
 * A crew character, always on white and always whole: the picture is fitted
 * inside its frame and sits on the bottom edge, so feet are never cut off.
 */
export function CrewArt({ look, height = 220, style }: { look: CrewLook; height?: number; style?: StyleProp<ViewStyle> }) {
  const wide = look === "crew-group";
  return (
    <View style={[{ height, width: wide ? "100%" : Math.round((height * 2) / 3), backgroundColor: colours.canvas, alignSelf: "center" }, style]}>
      <Image source={CREW[look]} style={{ flex: 1 }} contentFit="contain" contentPosition="bottom" accessibilityIgnoresInvertColors />
    </View>
  );
}

/** A friendly empty or "nothing here yet" state with a crew character. */
export function Empty({ look, title, line, children }: { look: CrewLook; title: string; line?: string; children?: ReactNode }) {
  return (
    <View style={s.empty}>
      <CrewArt look={look} height={200} />
      <Title size={22} style={{ textAlign: "center" }}>
        {title}
      </Title>
      {line ? <Txt style={{ textAlign: "center", color: colours.inkSoft }}>{line}</Txt> : null}
      {children}
    </View>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <View style={s.loading} accessibilityLabel={label}>
      <ActivityIndicator color={colours.ink} />
      <Small>{label}…</Small>
    </View>
  );
}

export function Problem({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={{ gap: space.m }}>
      <Notice tone="warn">{message}</Notice>
      {onRetry ? <Button kind="ghost" label="Try again" onPress={onRetry} /> : null}
    </View>
  );
}

// ---------- form fields ----------

export function Field({ label, hint, style, ...input }: TextInputProps & { label: string; hint?: string; style?: StyleProp<TextStyle> }) {
  return (
    <View style={{ gap: 6 }}>
      <Strong>{label}</Strong>
      <TextInput placeholderTextColor={colours.inkFaint} style={[s.input, style]} {...input} />
      {hint ? <Small>{hint}</Small> : null}
    </View>
  );
}

export const s = StyleSheet.create({
  text: { fontFamily: fonts.text, fontSize: 16, lineHeight: 23, color: colours.ink },
  strong: { fontFamily: fonts.textBold },
  small: { fontSize: 13.5, lineHeight: 19, color: colours.inkSoft },
  kicker: { fontFamily: fonts.textBold, fontSize: 12.5, letterSpacing: 1, textTransform: "uppercase", color: colours.ink },
  title: { fontFamily: fonts.display, color: colours.ink, letterSpacing: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: space.s },
  word: { alignItems: "center" },
  wordBig: { fontFamily: fonts.display, fontSize: 24, lineHeight: 26, color: colours.ink },
  wordSmall: { fontFamily: fonts.textMedium, fontSize: 7.5, letterSpacing: 3.4, marginRight: -3.4, color: colours.ink },
  topbar: {
    height: 56,
    paddingHorizontal: space.l,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colours.canvas,
  },
  avatarBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: colours.lilac, alignItems: "center", justifyContent: "center" },
  avatarText: { fontFamily: fonts.textBold, fontSize: 15, color: colours.ink },
  screen: { flex: 1, backgroundColor: colours.canvas },
  page: { padding: space.l, paddingBottom: 40, gap: space.xl },
  hero: { borderRadius: radius.l, padding: space.xl, gap: space.s },
  lead: { fontSize: 16.5, lineHeight: 24 },
  section: {},
  card: { backgroundColor: colours.canvas, borderRadius: radius.m, borderWidth: 1, borderColor: colours.line, padding: space.l, gap: space.s },
  pressed: { opacity: 0.75, transform: [{ scale: 0.985 }] },
  btn: { minHeight: 50, borderRadius: radius.pill, paddingHorizontal: space.xl, alignItems: "center", justifyContent: "center" },
  btnSmall: { minHeight: 38, paddingHorizontal: space.l },
  btnGhost: { borderWidth: 1.5, borderColor: colours.ink },
  btnText: { fontFamily: fonts.textBold, fontSize: 16 },
  btnTextSmall: { fontSize: 14.5 },
  tag: { alignSelf: "flex-start", borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  tagText: { fontFamily: fonts.textBold, fontSize: 12.5, color: colours.ink },
  figures: { flexDirection: "row", flexWrap: "wrap", gap: space.m },
  figure: { flexGrow: 1, flexBasis: "40%", backgroundColor: colours.panel, borderRadius: radius.m, padding: space.l, gap: 2 },
  figureValue: { fontFamily: fonts.display, fontSize: 26, lineHeight: 30, color: colours.ink },
  rowLine: { flexDirection: "row", alignItems: "center", gap: space.m, paddingVertical: 6 },
  notice: { backgroundColor: colours.panel, borderRadius: radius.m, padding: space.l },
  empty: { alignItems: "center", gap: space.m, paddingVertical: space.l },
  loading: { alignItems: "center", gap: space.s, paddingVertical: space.xxl },
  input: {
    fontFamily: fonts.text,
    fontSize: 17,
    color: colours.ink,
    minHeight: 50,
    borderWidth: 1.5,
    borderColor: colours.line,
    borderRadius: radius.s,
    paddingHorizontal: space.m,
    backgroundColor: colours.canvas,
  },
});
