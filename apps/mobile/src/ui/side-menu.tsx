import * as WebBrowser from "expo-web-browser";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "expo-router";
import { Animated, PanResponder, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { API_URL } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Icon } from "./icons";
import { colours, fonts, radius, space } from "./theme";

// The side menu: the member's account at the top, then the extras that do
// not fit on the phone bar. Until each one is built for the phone, it opens
// the same page of the website inside the app.

type Extra = { icon: string; label: string; line: string; page: string; tint: string; plus?: boolean };

const EXTRAS: Extra[] = [
  { icon: "pin", label: "My trip", line: "Plan a route round the shops", page: "Planner", tint: colours.pistachio, plus: true },
  { icon: "research", label: "Research", line: "Check any item before you buy", page: "Research", tint: colours.butter, plus: true },
  { icon: "heart", label: "Saved finds", line: "Deals you have kept for later", page: "Saved", tint: colours.lemon },
  { icon: "crew", label: "The crew", line: "Members, levels and points", page: "Crew", tint: colours.lemon },
  { icon: "star", label: "Plans", line: "Starter, Plus and Full-time", page: "Plans", tint: colours.candy },
  { icon: "settings", label: "Settings", line: "Travel, buying rules and your area", page: "Profile", tint: colours.lilac },
];

const MenuContext = createContext<{ open: () => void } | null>(null);

export function useMenu() {
  const menu = useContext(MenuContext);
  if (!menu) throw Error("useMenu needs MenuProvider");
  return menu;
}

// Like X and Uber: the menu sits underneath, and opening it pushes the
// whole app to the right, leaving a dimmed strip of the page you were on.
// Swipe in from the left edge to open it; swipe back or tap the strip to
// close it.

const SPRING = { damping: 24, stiffness: 240, mass: 0.9, useNativeDriver: true } as const;
const TAB_PATHS = ["/deals", "/tips", "/scan", "/stock", "/money"];
const clamp = (n: number) => Math.min(1, Math.max(0, n));

export function MenuProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const pathname = usePathname();
  const panel = Math.min(320, Math.round(width * 0.82));
  const [progress] = useState(() => new Animated.Value(0));
  const [isOpen, setOpen] = useState(false);

  const settle = useCallback(
    (to: 0 | 1) => {
      setOpen(to === 1);
      Animated.spring(progress, { toValue: to, ...SPRING }).start();
    },
    [progress],
  );
  const open = useCallback(() => settle(1), [settle]);
  const close = useCallback(() => settle(0), [settle]);

  // Swipe in from the left edge of a tab to open.
  const edge = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => g.dx > 6 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderMove: (_, g) => progress.setValue(clamp(g.dx / panel)),
        onPanResponderRelease: (_, g) => settle(g.vx > 0.3 || g.dx > panel / 3 ? 1 : 0),
        onPanResponderTerminate: () => settle(0),
      }),
    [panel, progress, settle],
  );
  // Swipe the pushed-aside page back to close.
  const back = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => g.dx < -6 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderMove: (_, g) => progress.setValue(clamp(1 + g.dx / panel)),
        onPanResponderRelease: (_, g) => settle(g.vx < -0.3 || g.dx < -panel / 3 ? 0 : 1),
        onPanResponderTerminate: () => settle(1),
      }),
    [panel, progress, settle],
  );

  const value = useMemo(() => ({ open }), [open]);
  const onTab = TAB_PATHS.includes(pathname);

  return (
    <MenuContext.Provider value={value}>
      <View style={styles.root}>
        {enabled ? (
          <Animated.View
            importantForAccessibility={isOpen ? "auto" : "no-hide-descendants"}
            accessibilityElementsHidden={!isOpen}
            style={[
              styles.panel,
              { width: panel, paddingTop: insets.top + space.m, paddingBottom: insets.bottom + space.m },
              {
                opacity: progress.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 0.6, 1] }),
                transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [-panel * 0.25, 0] }) }],
              },
            ]}
          >
            <MenuList onClose={close} />
          </Animated.View>
        ) : null}

        <Animated.View
          style={[
            styles.app,
            isOpen && styles.appLifted,
            { transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, panel] }) }] },
          ]}
        >
          {children}
          {isOpen ? (
            <Animated.View
              style={[StyleSheet.absoluteFill, styles.shade, { opacity: progress }]}
              {...back.panHandlers}
            >
              <Pressable accessibilityRole="button" accessibilityLabel="Close menu" style={StyleSheet.absoluteFill} onPress={close} />
            </Animated.View>
          ) : null}
        </Animated.View>

        {enabled && onTab && !isOpen ? (
          // Starts below the top bar so the menu button stays tappable.
          <View style={[styles.edge, { top: insets.top + 56 }]} {...edge.panHandlers} />
        ) : null}
      </View>
    </MenuContext.Provider>
  );
}

function MenuList({ onClose }: { onClose: () => void }) {
  const { user, signOut } = useAuth();
  const [leaving, setLeaving] = useState(false);

  const go = async (page: string) => {
    onClose();
    await WebBrowser.openBrowserAsync(`${API_URL}/#${page}`);
  };
  const out = async () => {
    setLeaving(true);
    try {
      onClose();
      await signOut();
    } finally {
      setLeaving(false);
    }
  };
  const initial = (user?.name || user?.email || "B").trim().charAt(0).toUpperCase();

  return (
    <>
        <View style={styles.head}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initial}</Text>
          </View>
          <View style={{ flex: 1 }}>
            {user?.name ? <Text style={styles.name} numberOfLines={1}>{user.name}</Text> : null}
            <Text style={styles.email} numberOfLines={1}>
              {user?.email ?? "Bounty member"}
            </Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close menu" onPress={onClose} hitSlop={10} style={styles.close}>
            <Icon name="close" size={18} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ gap: 4, paddingVertical: space.m }}>
          {EXTRAS.map((x) => (
            <Pressable key={x.page} accessibilityRole="button" onPress={() => go(x.page)} style={({ pressed }) => [styles.item, pressed && { backgroundColor: colours.panel }]}>
              <View style={[styles.icon, { backgroundColor: x.tint }]}>
                <Icon name={x.icon} size={20} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>
                  {x.label}
                  {x.plus ? <Text style={styles.plus}>  Plus</Text> : null}
                </Text>
                <Text style={styles.line}>{x.line}</Text>
              </View>
              <Icon name="chev" size={18} colour={colours.inkFaint} />
            </Pressable>
          ))}
          <Text style={styles.note}>These open the Bounty website for now, until each has its own phone screen.</Text>
        </ScrollView>

        <Pressable accessibilityRole="button" onPress={out} disabled={leaving} style={({ pressed }) => [styles.item, pressed && { backgroundColor: colours.panel }]}>
          <View style={[styles.icon, { backgroundColor: colours.panel }]}>
            <Icon name="out" size={20} />
          </View>
          <Text style={[styles.label, { flex: 1 }]}>{leaving ? "Signing out…" : "Sign out"}</Text>
        </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colours.panel },
  app: { flex: 1, backgroundColor: colours.canvas, overflow: "hidden" },
  appLifted: {
    borderTopLeftRadius: radius.l,
    borderBottomLeftRadius: radius.l,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: -4, height: 0 },
    elevation: 12,
  },
  shade: { backgroundColor: "rgba(17,17,17,0.12)" },
  edge: { position: "absolute", left: 0, bottom: 0, width: 16 },
  panel: { position: "absolute", top: 0, bottom: 0, left: 0, paddingHorizontal: space.m },
  head: { flexDirection: "row", alignItems: "center", gap: space.m, padding: space.s, paddingBottom: space.l, borderBottomWidth: 1, borderBottomColor: colours.line },
  avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: colours.lilac, alignItems: "center", justifyContent: "center" },
  avatarText: { fontFamily: fonts.display, fontSize: 22, color: colours.ink },
  name: { fontFamily: fonts.textBold, fontSize: 16, color: colours.ink },
  email: { fontFamily: fonts.text, fontSize: 14, color: colours.inkSoft },
  close: { width: 34, height: 34, borderRadius: 17, backgroundColor: colours.panel, alignItems: "center", justifyContent: "center" },
  item: { flexDirection: "row", alignItems: "center", gap: space.m, padding: space.s, borderRadius: radius.m },
  icon: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  label: { fontFamily: fonts.textBold, fontSize: 16, color: colours.ink },
  plus: { fontFamily: fonts.textBold, fontSize: 12, color: colours.brand },
  line: { fontFamily: fonts.text, fontSize: 13.5, color: colours.inkSoft },
  note: { fontFamily: fonts.text, fontSize: 12.5, color: colours.inkFaint, paddingHorizontal: space.s, paddingTop: space.m },
});
