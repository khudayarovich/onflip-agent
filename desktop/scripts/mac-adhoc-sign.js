const { execFileSync } = require("node:child_process");

/**
 * Ad-hoc sign the macOS app before it is put into a dmg.
 *
 * Apple Silicon will not run an unsigned binary at all: the kernel refuses
 * it, and Finder reports the app as "damaged and can't be opened" — which
 * is what shipped in 0.4.0, where signing was disabled outright because CI
 * has no certificate. Intel builds are exempt, which is why only the arm64
 * dmg was broken.
 *
 * An ad-hoc signature (`--sign -`) needs no certificate and satisfies that
 * requirement. It is not notarisation and does not pretend to be: the first
 * launch still needs right-click → Open, because the app is not from an
 * identified developer. This only stops macOS from treating the build as
 * corrupt.
 */
exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  try {
    execFileSync(
      "codesign",
      ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath],
      { stdio: "inherit" }
    );
    // Prove it took, rather than trusting a silent exit.
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
    console.log(`ad-hoc signed ${appPath} (${context.arch === 1 ? "x64" : "arm64"})`);
  } catch (e) {
    // A dmg with an unsigned arm64 app inside is worse than no dmg: it looks
    // like a corrupt download to every user who opens it.
    throw new Error(`ad-hoc signing failed for ${appPath}: ${e.message}`);
  }
};
