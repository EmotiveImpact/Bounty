// Talks to the same Bounty server as the website, so the phone and the site
// always show the same deals, tips and records. All money is integer pence.
//
// Sign-in uses the website's session cookie. iOS and Android keep cookies
// for the app between launches, so a member stays signed in for 30 days,
// just as on the website.

/** The server the app talks to. Set EXPO_PUBLIC_API_URL to use another one. */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "https://bounty-nu.vercel.app").replace(/\/$/, "");

/** Thrown when a change needs a signed-in member. */
export class SignInNeeded extends Error {}

export async function api<T>(
  route: string,
  body?: unknown,
  method?: "POST" | "PUT" | "PATCH" | "DELETE",
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(
      API_URL + "/api/" + route,
      body === undefined && !method
        ? { credentials: "include" }
        : {
            method: method || "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body ?? {}),
          },
    );
  } catch {
    throw Error("Bounty could not be reached. Check your signal and try again.");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw Error("Bounty sent back something unreadable. Try again in a minute.");
  }
  if (res.status === 401 && (data as { signIn?: boolean } | null)?.signIn)
    throw new SignInNeeded("Sign in to save changes");
  if (!res.ok)
    throw Error((data as { error?: string } | null)?.error || "Something went wrong (HTTP " + res.status + ")");
  return data as T;
}

/** A photo or picture the website serves, such as a product photo. */
export const siteFile = (path: string) => API_URL + "/" + path.replace(/^\//, "");
