export interface SessionCookie {
  name: string;
  value: string;
}

export interface SessionInfo {
  accessToken: string;
  expires?: string;
  user?: { email?: string; name?: string };
}

export async function fetchAccessToken(cookies: SessionCookie[]): Promise<SessionInfo> {
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const res = await fetch("https://chatgpt.com/api/auth/session", {
    headers: {
      cookie: cookieHeader,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(`Auth session request failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as SessionInfo;
  if (!data?.accessToken) {
    throw new Error(
      "No access token returned. Your ChatGPT session may be expired. Re-login in your browser or run `onflip login`."
    );
  }
  return data;
}
