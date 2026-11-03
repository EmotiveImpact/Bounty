import {
  GoogleSans_400Regular,
  GoogleSans_500Medium,
  GoogleSans_700Bold,
  useFonts,
} from "@expo-google-fonts/google-sans";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";
import { MenuProvider } from "@/ui/side-menu";
import { colours } from "@/ui/theme";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, failed] = useFonts({
    GoogleSans_400Regular,
    GoogleSans_500Medium,
    GoogleSans_700Bold,
    "CalSans-Medium": require("@/assets/fonts/CalSans-Medium.ttf"),
  });
  if (!loaded && !failed) return null;
  return (
    <AuthProvider>
      <StatusBar style="dark" />
      <Screens />
    </AuthProvider>
  );
}

// Signed out, the app opens on the welcome screen with sign in and sign up.
// Signed in, it opens on Deals. The splash stays up until we know which.
function Screens() {
  const { checking, signedIn } = useAuth();

  useEffect(() => {
    if (!checking) SplashScreen.hideAsync();
  }, [checking]);

  if (checking) return null;

  return (
    <MenuProvider>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colours.canvas } }}>
        <Stack.Screen name="index" />
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="deal/[sku]" />
          <Stack.Screen name="add-stock" options={{ presentation: "modal" }} />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="welcome" />
          <Stack.Screen name="sign-in" />
        </Stack.Protected>
      </Stack>
    </MenuProvider>
  );
}
