import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/lib/auth";
import { Icon } from "@/ui/icons";
import { Button, CrewArt, Field, Notice, Small, Title, Txt } from "@/ui/kit";
import { colours, fonts, space } from "@/ui/theme";

// Sign in or create an account. The same accounts as the website, so one
// email and password works on both.

export default function SignIn() {
  const params = useLocalSearchParams<{ mode?: string }>();
  const insets = useSafeAreaInsets();
  const { signIn, signUp, inviteOpen } = useAuth();
  const [mode, setMode] = useState<"in" | "up">(params.mode === "up" ? "up" : "in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    if (!email.trim() || !password) return setError("Enter your email and password.");
    if (mode === "up" && password.length < 10) return setError("Use a password of at least 10 characters.");
    if (mode === "up" && !invite.trim()) return setError("Enter the invite code you were given.");
    setBusy(true);
    try {
      if (mode === "in") await signIn(email, password);
      else await signUp({ email, password, name, invite });
      // Signed in: the app moves on to Deals by itself.
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/welcome"))}
          hitSlop={10}
          style={styles.close}
        >
          <Icon name="back" size={20} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <CrewArt look={mode === "in" ? "negotiator-deal" : "boss-thumbs"} height={190} />
        <Title size={32} style={{ textAlign: "center" }}>
          {mode === "in" ? "Welcome back" : "Join the crew"}
        </Title>
        <Txt style={{ textAlign: "center", color: colours.inkSoft }}>
          {mode === "in"
            ? "Sign in to pick up your finds, trips and stock where you left them. Same account as the website."
            : "Create your Bounty account to save finds, plan trips and track your stock."}
        </Txt>
        {mode === "up" ? <Field label="Your name" value={name} onChangeText={setName} autoComplete="name" textContentType="name" maxLength={80} /> : null}
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          autoComplete="email"
          textContentType="emailAddress"
        />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete={mode === "in" ? "current-password" : "new-password"}
          textContentType={mode === "in" ? "password" : "newPassword"}
          hint={mode === "up" ? "At least 10 characters." : undefined}
        />
        {mode === "up" ? <Field label="Invite code" value={invite} onChangeText={setInvite} autoCapitalize="none" autoCorrect={false} /> : null}
        {error ? <Notice tone="warn">{error}</Notice> : null}
        <Button label={mode === "in" ? "Sign in" : "Create my account"} busy={busy} onPress={submit} />
        <Small style={{ textAlign: "center" }}>You stay signed in on this phone for 30 days.</Small>
        {inviteOpen || mode === "up" ? (
          <Pressable accessibilityRole="button" onPress={() => (setMode(mode === "in" ? "up" : "in"), setError(""))} style={{ alignSelf: "center", padding: space.s }}>
            <Text style={styles.switch}>{mode === "in" ? "New to Bounty? Create an account" : "Already a member? Sign in"}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colours.canvas },
  bar: { height: 56, justifyContent: "center", alignItems: "flex-start", paddingHorizontal: space.m },
  close: { width: 40, height: 40, borderRadius: 20, backgroundColor: colours.panel, alignItems: "center", justifyContent: "center" },
  page: { padding: space.l, paddingBottom: 48, gap: space.l },
  switch: { fontFamily: fonts.textBold, fontSize: 15, color: colours.ink, textDecorationLine: "underline" },
});
