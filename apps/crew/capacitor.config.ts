import type { CapacitorConfig } from "@capacitor/cli";

// Android first (company tablets under device management). Add iOS later with `npx cap add ios`.
const config: CapacitorConfig = {
  appId: "com.zentek.crew",
  appName: "Cutting Cost Crew",
  webDir: "dist",
  android: {
    allowMixedContent: false,
    // Background GPS (@capacitor-community/background-geolocation): without the legacy bridge,
    // Android stops delivering locations to the app after about 5 minutes in the background.
    useLegacyBridge: true,
  },
  plugins: {
    // Send network requests natively, so GPS points keep uploading when the app is in the
    // background (Android throttles the WebView's own requests after a few minutes).
    CapacitorHttp: { enabled: true },
  },
};

export default config;
