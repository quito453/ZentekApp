# Cutting Cost Office desktop app

A desktop window (Windows and Mac) around the office website. Owners and dispatchers get an app icon and their own window. Because it loads the live site, updates on Netlify reach them immediately, with no new installer.

This folder is not part of the root `npm install`, so CI and Netlify never download Electron.

```bash
cd apps/desktop
npm install
ZENTEK_OFFICE_URL=http://127.0.0.1:5173 npm start   # try it against your local office app
npm run dist:win                                     # build the Windows installer (on Windows)
npm run dist:mac                                     # build the Mac installer (on a Mac)
```

Set the real address in `package.json` under `zentek.officeUrl` before building installers.

Before handing installers to customers, sign them (a Windows code-signing certificate and an Apple Developer ID). Otherwise Windows and macOS warn that the app is from an unknown developer.
