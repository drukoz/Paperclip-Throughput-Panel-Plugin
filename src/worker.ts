import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("throughput panel worker starting");
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
