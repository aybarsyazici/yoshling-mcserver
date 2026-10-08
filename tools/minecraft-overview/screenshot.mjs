import { createServer } from "node:http";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
export function decodeVerifiedCanvas(capture, errors = []) {
  if (errors.length || capture.width !== 1280 || capture.height !== 800 ||
      !Number.isSafeInteger(capture.vertices) || capture.vertices < 1 || typeof capture.data !== "string" ||
      !capture.data.startsWith("data:image/png;base64,") || capture.data.length > 7 * 1024 * 1024)
    throw new Error("Rendered canvas could not be verified");
  const png = Buffer.from(capture.data.slice("data:image/png;base64,".length), "base64");
  if (png.length < 33 || png.length > 5 * 1024 * 1024 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.toString("ascii", 12, 16) !== "IHDR" ||
      png.readUInt32BE(16) !== 1280 || png.readUInt32BE(20) !== 800) throw new Error("Rendered PNG exceeds bounds");
  return png;
}
export async function screenshot(webRoot, output, center, playwrightPath = "playwright") {
  webRoot = await realpath(webRoot);
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
    ".png": "image/png", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const file = path.resolve(webRoot, "." + (pathname === "/" ? "/index.html" : pathname));
      if (!file.startsWith(webRoot + path.sep)) { response.writeHead(404).end(); return; }
      const canonical = await realpath(file);
      if (!canonical.startsWith(webRoot + path.sep) || !(await stat(canonical)).isFile()) { response.writeHead(404).end(); return; }
      const bytes = await readFile(canonical);
      response.writeHead(200, { "Content-Type": mime[path.extname(canonical)] || "application/octet-stream", "Cache-Control": "no-store" });
      response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = "http://127.0.0.1:" + server.address().port;
  let browser;
  try {
    const { chromium } = require(playwrightPath);
    browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage", "--no-sandbox"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin + "/#overview:" + center.x + ":64:" + center.z + ":115:2.4:0.9:0:0:perspective", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.bluemap?.mapViewer?.data?.mapState === "loaded");
    await page.waitForFunction(() => {
      const manager = window.bluemap.mapViewer.map?.hiresTileManager;
      return manager && manager.currentlyLoading === 0 && [...manager.tiles.values()].some(tile => tile.loaded && tile.model?.geometry?.attributes?.position?.count > 0);
    });
    await page.evaluate(center => {
      const viewer = window.bluemap.mapViewer;
      const terrain = viewer.map.terrainHeightAt(center.x, center.z);
      if (Number.isFinite(terrain)) viewer.controlsManager.position.y = terrain + 3;
    }, center);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const capture = await page.evaluate(() => {
      const viewer = window.bluemap.mapViewer;
      viewer.render();
      const canvas = viewer.renderer.domElement;
      return { data: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height,
        vertices: [...viewer.map.hiresTileManager.tiles.values()].reduce((sum, tile) => sum + (tile.model?.geometry?.attributes?.position?.count || 0), 0) };
    });
    const png = decodeVerifiedCanvas(capture, errors);
    await writeFile(output, png, { mode: 0o600 });
    if (!(await readFile(output)).equals(png)) throw new Error("Rendered image readback failed");
    return { width: capture.width, height: capture.height, bytes: png.length, sha256: createHash("sha256").update(png).digest("hex"), vertices: capture.vertices };
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const result = await screenshot(process.argv[2], process.argv[3], { x: 0, z: 0 }, process.env.OVERVIEW_PLAYWRIGHT || "playwright");
  console.log(JSON.stringify(result));
}
