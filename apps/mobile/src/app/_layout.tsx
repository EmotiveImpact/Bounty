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
import { AuthProvider } from "@/lib/auth";
import { colours } from "@/ui/theme";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, failed] = useFonts({
    GoogleSans_400Regular,
    GoogleSans_500Medium,
    GoogleSans_700Bold,
    "CalSans-Medium": require("@/assets/fonts/CalSans-Medium.ttf"),
  });

  useEffect(() => {
    if (loaded || failed) SplashScreen.hideAsync();
  }, [loaded, failed]);

  if (!loaded && !failed) return null;

  return (
    <AuthProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colours.canvas } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="deal/[sku]" />
        <Stack.Screen name="sign-in" options={{ presentation: "modal" }} />
        <Stack.Screen name="account" options={{ presentation: "modal" }} />
        <Stack.Screen name="add-stock" options={{ presentation: "modal" }} />
      </Stack>
    </AuthProvider>
  );
}
