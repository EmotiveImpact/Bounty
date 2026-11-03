import * as WebBrowser from "expo-web-browser";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
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

export function MenuProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [slide] = useState(() => new Animated.Value(0));
  const open = useCallback(() => {
    setVisible(true);
    Animated.timing(slide, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [slide]);
  const close = useCallback(() => {
    Animated.timing(slide, { toValue: 0, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => setVisible(false));
  }, [slide]);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <MenuContext.Provider value={value}>
      {children}
      <SideMenu visible={visible} slide={slide} onClose={close} />
    </MenuContext.Provider>
  );
}

function SideMenu({ visible, slide, onClose }: { visible: boolean; slide: Animated.Value; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { user, signOut } = useAuth();
  const panel = Math.min(340, Math.round(width * 0.86));
  const [leaving, setLeaving] = useState(false);

  const go = async (page: string) => {
    onClose();
    await WebBrowser.openBrowserAsync(`${API_URL}/#${page}`);
  };
  const out = async () => {
    setLeaving(true);
    try {
      await signOut();
      onClose();
    } finally {
      setLeaving(false);
    }
  };
  const initial = (user?.name || user?.email || "B").trim().charAt(0).toUpperCase();

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, styles.shade, { opacity: slide }]}>
        <Pressable accessibilityLabel="Close menu" style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        style={[
          styles.panel,
          { width: panel, paddingTop: insets.top + space.m, paddingBottom: insets.bottom + space.m },
          { transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [-panel, 0] }) }] },
        ]}
      >
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
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  shade: { backgroundColor: "rgba(17,17,17,0.35)" },
  panel: { position: "absolute", top: 0, bottom: 0, left: 0, backgroundColor: colours.canvas, paddingHorizontal: space.m, borderTopRightRadius: radius.l, borderBottomRightRadius: radius.l },
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
