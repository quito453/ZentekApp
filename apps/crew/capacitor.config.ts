import type { CapacitorConfig } from "@capacitor/cli";

// Android first (company tablets under device management). Add iOS later with `npx cap add ios`.
const config: CapacitorConfig = {
  appId: "com.zentek.crew",
  appName: "Cutting Cost Crew",
  webDir: "dist",
  android: {
    // Keep the WebView running while the screen is off so queued work keeps uploading.
    // Background GPS needs a native location plugin with a foreground service; added in Stage 3.
    allowMixedContent: false,
  },
};

export default config;
