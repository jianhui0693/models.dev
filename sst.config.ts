/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app() {
    return {
      name: "models-dev",
      home: "cloudflare",
    };
  },
  async run() {
    const { spawnSync } = await import("child_process");

    const ret = spawnSync("./script/build.ts", [], {
      cwd: "./packages/web",
      stdio: "inherit",
    });
    if (ret.status !== 0) throw new Error("Build failed");

    const worker = new sst.cloudflare.Worker("Server", {
      url: true,
      // Fork customization: bind a custom domain only when SITE_DOMAIN is set;
      // otherwise fall back to the Cloudflare-assigned workers.dev URL.
      domain: $app.stage === "dev" ? process.env.SITE_DOMAIN : undefined,
      link: [
        new sst.Secret("PosthogToken"),
        new sst.Secret("LakeUrl"),
        new sst.Secret("LakeSecret"),
      ],
      handler: "./packages/function/src/worker.ts",
      assets: {
        directory: "./packages/web/dist",
      },
      transform: {
        worker: {
          observability: { enabled: true },
        },
      },
    });

    // Fork customization: only create the extra custom domain when the
    // SITE_HOSTNAME / SITE_ZONE env vars are provided.
    if ($app.stage === "dev" && process.env.SITE_HOSTNAME && process.env.SITE_ZONE) {
      const zone = cloudflare.getZoneOutput({
        filter: {
          account: { id: process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID! },
          name: process.env.SITE_ZONE,
        },
      });

      new cloudflare.WorkersCustomDomain("OpenCodeDomain", {
        accountId: process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID!,
        environment: "production",
        hostname: process.env.SITE_HOSTNAME,
        service: worker.nodes.worker.scriptName,
        zoneId: zone.zoneId,
      });
    }

    return {
      url: worker.url,
    };
  },
});
