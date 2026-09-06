/**
 * The brand list a Chromium window shows the web.
 *
 * Two different checks read this, and until now they wanted opposite things.
 *
 * Cloudflare compares the `Sec-CH-UA` header against `navigator.userAgentData`
 * and objects when they disagree. Google compares the brand list against its
 * own idea of a supported browser and refuses OAuth when the answer is only
 * "Chromium" — the "this browser or app may not be secure" page, which is
 * where a sign-in with Google dead-ends.
 *
 * Earlier attempts satisfied one at a time. Claiming Google Chrome in the
 * header alone left the JavaScript saying Chromium, which is the very
 * contradiction Cloudflare looks for. Saying Chromium in both was consistent
 * and honest, and Google went on refusing it.
 *
 * They are only in conflict while the header and the JavaScript are set
 * separately. Set from one list — the header written from it and
 * `Emulation.setUserAgentOverride` given it as metadata — both say Google
 * Chrome and both say the same thing, which is what each check is actually
 * asking for. Measured against Google's own endpoint, same session, back to
 * back: `Chromium` landed on `/signin/rejected` with no login form, and
 * `Google Chrome` beside it landed on `/signin/identifier` with the form
 * present.
 *
 * The list is grown from the one Chromium reports rather than written out
 * here, so the versions stay whatever is really rendering the page and no
 * hard-coded number drifts at the next Electron bump.
 */

export interface Brand {
  brand: string;
  version: string;
}

/** Chromium's own entry, which carries the version the others copy. */
function chromiumEntry(brands: Brand[]): Brand | undefined {
  return brands.find((b) => /^chromium$/i.test(b.brand));
}

export function hasGoogleChrome(brands: Brand[]): boolean {
  return brands.some((b) => /^google chrome$/i.test(b.brand));
}

/**
 * Add a Google Chrome entry alongside Chromium's, at Chromium's version.
 *
 * Placed immediately before Chromium, which is where real Chrome puts it.
 * Left alone when it is already there, or when there is no Chromium entry to
 * take a version from — inventing one from nothing would be a guess, and a
 * wrong version is a worse signal than a missing brand.
 *
 * The GREASE entry ("Not?A_Brand") is never touched. Chrome varies it on
 * purpose to keep parsers honest, and normalising it away would itself stand
 * out.
 */
export function withGoogleChrome(brands: Brand[]): Brand[] {
  if (!brands.length || hasGoogleChrome(brands)) return brands;
  const chromium = chromiumEntry(brands);
  if (!chromium) return brands;
  const out: Brand[] = [];
  for (const b of brands) {
    if (b === chromium) out.push({ brand: "Google Chrome", version: chromium.version });
    out.push(b);
  }
  return out;
}

/** Render a brand list the way the `Sec-CH-UA` header spells it. */
export function renderBrands(brands: Brand[]): string {
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(", ");
}

/**
 * Read a `Sec-CH-UA` header back into a list.
 *
 * Deliberately forgiving: an entry it cannot parse is dropped rather than
 * throwing, because the alternative to a slightly short brand list is no
 * header at all, and a missing header is the louder signal of the two.
 */
export function parseBrands(header: string): Brand[] {
  const out: Brand[] = [];
  for (const part of header.split(",")) {
    const m = /^\s*"([^"]*)"\s*;\s*v\s*=\s*"([^"]*)"\s*$/.exec(part);
    if (m) out.push({ brand: m[1], version: m[2] });
  }
  return out;
}

/**
 * The brand list to use when Chromium's own could not be read.
 *
 * Only the major version is known in this case — it comes out of the user
 * agent string — so the full-version list cannot be built and the caller
 * should not send one.
 */
export function fallbackBrands(major: string): Brand[] {
  if (!major) return [];
  return [
    { brand: "Not?A_Brand", version: "99" },
    { brand: "Google Chrome", version: major },
    { brand: "Chromium", version: major },
  ];
}
