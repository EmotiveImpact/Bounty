import { Redirect } from "expo-router";
import { useAuth } from "@/lib/auth";

// Opening the app: signed out goes to the welcome screen, signed in to Deals.
export default function Start() {
  const { signedIn } = useAuth();
  return <Redirect href={signedIn ? "/deals" : "/welcome"} />;
}
