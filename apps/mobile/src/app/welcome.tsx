import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/lib/auth";
import { Button, CrewArt, Small, Title, Txt, Wordmark } from "@/ui/kit";
import { colours, space } from "@/ui/theme";

// The first screen for anyone signed out: the crew, one line on what Bounty
// does, and two stacked buttons.

export default function Welcome() {
  const insets = useSafeAreaInsets();
  const { inviteOpen } = useAuth();
  return (
    <View style={[styles.screen, { paddingTop: insets.top + space.l, paddingBottom: insets.bottom + space.l }]}>
      <Wordmark />
      <View style={styles.middle}>
        <CrewArt look="crew-group" height={250} />
        <Title size={36} style={{ textAlign: "center" }}>
          Buy low near you.{"\n"}Sell for more.
        </Title>
        <Txt style={styles.lead}>Deals checked against what things really sell for, tips from members near you, and a scanner for the shop.</Txt>
      </View>
      <View style={{ gap: space.m }}>
        {inviteOpen ? <Button label="Create an account" onPress={() => router.push({ pathname: "/sign-in", params: { mode: "up" } })} /> : null}
        <Button kind={inviteOpen ? "ghost" : "main"} label="Sign in" onPress={() => router.push("/sign-in")} />
        <Small style={{ textAlign: "center" }}>{inviteOpen ? "New accounts need the invite code you were given." : "Sign-up is closed for now. Ask Edem for an account."}</Small>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colours.canvas, paddingHorizontal: space.l },
  middle: { flex: 1, justifyContent: "center", gap: space.l },
  lead: { textAlign: "center", color: colours.inkSoft, fontSize: 17, lineHeight: 25 },
});
