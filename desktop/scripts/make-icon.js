/**
 * Rasterise buildResources/logo.svg into the PNG sizes an app icon needs and
 * pack the Windows sizes into buildResources/icon.ico.
 *
 * Playwright (resolved from the repository root's node_modules) does the
 * rendering, so no image tooling has to be installed. ICO entries are stored
 * as PNGs, which every Windows version since Vista reads.
 */
const fs = require("node:fs");
const path = require("node:path");

const RES = path.join(__dirname, "..", "buildResources");
const SVG = path.join(RES, "logo.svg");
const SIZES = [1024, 512, 256, 128, 64, 48, 32, 16];
const ICO_SIZES = [256, 128, 64, 48, 32, 16];

async function launch(playwright) {
  // The user's real Chrome first — same preference the core makes — with the
  // bundled build as fallback.
  try {
    return await playwright.chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return await playwright.chromium.launch({ headless: true });
  }
}

async function render() {
  const playwright = require("playwright");
  const svg = fs.readFileSync(SVG, "utf8");
  const browser = await launch(playwright);
  try {
    const page = await browser.newPage();
    for (const size of SIZES) {
      await page.setViewportSize({ width: size, height: size });
      const html = `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`;
      await page.setContent(html, { waitUntil: "load" });
      const file = path.join(RES, `icon-${size}.png`);
      await page.screenshot({ path: file, omitBackground: true });
      console.log(`rendered ${path.basename(file)}`);
    }
  } finally {
    await browser.close();
  }
}

/** Pack PNG files into a single .ico. */
function packIco() {
  const images = ICO_SIZES.map((size) => ({
    size,
    data: fs.readFileSync(path.join(RES, `icon-${size}.png`)),
  }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0); // width (0 = 256)
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1); // height
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.data.length;
    entries.push(entry);
  }

  const out = path.join(RES, "icon.ico");
  fs.writeFileSync(out, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
  console.log(`packed ${path.basename(out)} (${ICO_SIZES.join(", ")})`);
}

render()
  .then(packIco)
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
