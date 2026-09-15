/**
 * Whether OnFlip should report itself signed in, per service.
 *
 * Pure and separate because the version that lived inline got this wrong in
 * the one way that matters, and an authorization state is worth being able to
 * hold against every combination without launching anything.
 *
 * What it got wrong: it answered yes whenever a ChatGPT cookie or a stored
 * ChatGPT token existed, whatever service was selected. Those say nothing
 * about DeepSeek or Qwen — their sessions live in their own browser profiles
 * — so a signed-out Qwen was reported as signed in because ChatGPT happened
 * to have a session on the same machine. Named in an external audit of the
 * shipped build, and it is the root of a day of confusing sign-in states.
 *
 * The rule is one sentence: a browser-driven service is signed in when its
 * own probe says so, and never otherwise.
 */
export interface SessionEvidence {
  /** The user signed out in the app. Outranks everything. */
  signedOut: boolean;
  /** Is this a service driven through a browser profile rather than an API? */
  browserProvider: boolean;
  /** ChatGPT cookies in hand. Meaningless for any other service. */
  hasCookies: boolean;
  /** A stored ChatGPT session token. Likewise. */
  hasStoredToken: boolean;
  /**
   * What the provider's own probe found, or null while it is still looking.
   *
   * Null is deliberately not "no". A probe that has not answered yet is an
   * unknown, and reporting a confident "signed out" during it is how the
   * account bar flickers a wrong answer on every start.
   */
  probe: boolean | null;
}

export function reportsSignedIn(e: SessionEvidence): boolean {
  if (e.signedOut) return false;
  if (e.browserProvider) return e.probe === true;
  // A probe that has looked and found nothing outranks credentials that are
  // merely present.
  //
  // Holding a cookie is not holding a session: the jar keeps what it was
  // given until something expires it, and a cookie the service stopped
  // honouring looks exactly like one it still does. The engine already
  // knows better — a turn that fails "signed-out" sets this to false
  // precisely so the app stops claiming a connection through every failed
  // turn — and that intent was being discarded one line later, because
  // `hasCookies` answered first and the probe never got a say.
  //
  // Only `false` counts, and `null` still means nobody has looked. The
  // difference matters at startup, where ChatGPT with cookies is reported
  // ready without probing at all: null keeps that fast path, false does not
  // exist yet, and nothing flickers.
  if (e.probe === false) return false;
  return e.hasCookies || e.hasStoredToken || e.probe === true;
}
