import { router } from "expo-router";
import { useState } from "react";
import { Linking, Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { API_URL } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Icon } from "@/ui/icons";
import { Button, Card, Notice, Small, Title, Txt } from "@/ui/kit";
import { colours, space } from "@/ui/theme";

// The member's account, opened from their round picture in the top bar.

export default function Account() {
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function out() {
    setBusy(true);
    setError("");
    try {
      await signOut();
      router.back();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: Platform.OS === "ios" ? 0 : insets.top }]}>
      <View style={styles.bar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => router.back()} hitSlop={10} style={styles.close}>
          <Icon name="close" size={20} />
        </Pressable>
      </View>
      <View style={styles.page}>
        <Title size={30}>Your account</Title>
        {user ? (
          <Card>
            {user.name ? <Txt>{user.name}</Txt> : null}
            <Small>{user.email}</Small>
          </Card>
        ) : (
          <Notice>You are signed out.</Notice>
        )}
        <Button kind="ghost" label="Open the website" onPress={() => Linking.openURL(API_URL)} />
        {error ? <Notice tone="warn">{error}</Notice> : null}
        {user ? <Button label="Sign out" busy={busy} onPress={out} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colours.canvas },
  bar: { height: 56, justifyContent: "center", alignItems: "flex-end", paddingHorizontal: space.m },
  close: { width: 40, height: 40, borderRadius: 20, backgroundColor: colours.panel, alignItems: "center", justifyContent: "center" },
  page: { padding: space.l, gap: space.l },
});
