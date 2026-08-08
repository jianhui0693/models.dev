#!/usr/bin/env bun

import { forEachRenderedPage, Providers, Models, renderDocument } from "../src/render";
import fs from "fs/promises";
import path from "path";

const startedAt = performance.now();
const log = (message: string) =>
  console.log(`[build] ${message} (${Math.round((performance.now() - startedAt) / 1000)}s)`);

log("cleaning dist");
await fs.rm("./dist", { recursive: true, force: true });
await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "dist",
  target: "bun",
});
// bun 1.2.x emits HTML entrypoints as `index-<hash>.html` (1.3.x emits
// `index.html`). Normalize so the rest of the pipeline can rely on
// `./dist/index.html` regardless of the bun version.
const distFiles = await fs.readdir("./dist");
const hashedHtml = distFiles.find((file) => /^index-[^/]+\.html$/.test(file));
if (hashedHtml) {
  await fs.rename(`./dist/${hashedHtml}`, "./dist/index.html");
}
log("bundled client assets");

for await (const file of new Bun.Glob("./public/*").scan()) {
  await Bun.write(file.replace("./public/", "./dist/"), Bun.file(file));
}

// bun 1.2.x bundles the client script but does not rewrite the HTML
// entrypoint's source-path references (./public/favicon.svg,
// ./src/index.css). Mirror those files into dist so static hosting
// resolves them regardless of the bun version.
await fs.mkdir("./dist/public", { recursive: true });
for (const file of await fs.readdir("./public")) {
  await Bun.write(`./dist/public/${file}`, Bun.file(`./public/${file}`));
}
await fs.mkdir("./dist/src", { recursive: true });
await Bun.write("./dist/src/index.css", Bun.file("./src/index.css"));

// Copy provider logos to dist/logos/
await fs.mkdir("./dist/logos", { recursive: true });

// First, copy the default logo
const defaultLogoPath = "../../providers/logo.svg";
const defaultLogo = Bun.file(defaultLogoPath);
if (await defaultLogo.exists()) {
  await Bun.write("./dist/logos/default.svg", defaultLogo);
}

// Then copy provider-specific logos
const providersDir = "../../providers";
const entries = await fs.readdir(providersDir, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isDirectory()) {
    const provider = entry.name;
    const logoPath = path.join(providersDir, provider, "logo.svg");
    const logoFile = Bun.file(logoPath);

    if (await logoFile.exists()) {
      await Bun.write(`./dist/logos/${provider}.svg`, logoFile);
    }
  }
}

// Copy lab logos to dist/logos/labs/
await fs.mkdir("./dist/logos/labs", { recursive: true });

const labsDir = "../../labs";
try {
  const labEntries = await fs.readdir(labsDir, { withFileTypes: true });
  for (const entry of labEntries) {
    if (entry.isDirectory()) {
      const lab = entry.name;
      const logoPath = path.join(labsDir, lab, "logo.svg");
      const logoFile = Bun.file(logoPath);

      if (await logoFile.exists()) {
        await Bun.write(`./dist/logos/labs/${lab}.svg`, logoFile);
      }
    }
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}

const template = (await Bun.file("./dist/index.html").text())
  .replace('src="./src/index.ts"', 'src="./index.js"');

// Render + write pages one at a time. Holding every rendered page in memory
// at once (each embeds the full search index) easily exceeds the memory
// available in constrained build environments (e.g. Cloudflare Workers
// Builds) — stream instead so peak memory stays at ~one page.
let pageCount = 0;
await forEachRenderedPage(async (route, rendered) => {
  const html = renderDocument(template, rendered);
  if (route === "/") {
    // _index.html: Workers static assets SPA-fallback convention
    // index.html: required by Cloudflare Pages as the site root entry
    await Bun.write("./dist/_index.html", html);
    await Bun.write("./dist/index.html", html);
  } else {
    const filePath = path.join("./dist", route, "index.html");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await Bun.write(filePath, html);
  }
  pageCount += 1;
  if (pageCount % 500 === 0) {
    log(`wrote ${pageCount} pages`);
  }
});
log(`wrote ${pageCount} pages`);

await Bun.write("./dist/api.json", JSON.stringify(Providers));
await Bun.write(
  "./dist/catalog.json",
  JSON.stringify({ models: Models, providers: Providers }),
);
await Bun.write("./dist/models.json", JSON.stringify(Models));

await fs.rename("./dist/api.json", "./dist/_api.json");
await fs.rename("./dist/catalog.json", "./dist/_catalog.json");
await fs.rename("./dist/models.json", "./dist/_models.json");
// The client fetches /api.json, /catalog.json and /models.json directly —
// keep non-underscored copies alongside the Workers-convention names.
for (const name of ["api.json", "catalog.json", "models.json"]) {
  await fs.copyFile(`./dist/_${name}`, `./dist/${name}`);
}

log("build complete");
