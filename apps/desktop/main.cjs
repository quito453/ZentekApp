// Cutting Cost Office desktop app: a window around the office website.
// The site itself is deployed on Netlify, so every update reaches desktop users at once,
// with no new installer. Change the address in package.json ("zentek.officeUrl"), or set
// ZENTEK_OFFICE_URL when testing (e.g. http://127.0.0.1:5173).
const { app, BrowserWindow, shell } = require("electron");
const pkg = require("./package.json");

const OFFICE_URL = process.env.ZENTEK_OFFICE_URL || pkg.zentek.officeUrl;
const officeOrigin = new URL(OFFICE_URL).origin;

// One window only: opening the app again focuses it.
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    title: "Cutting Cost Office",
    autoHideMenuBar: true,
    webPreferences: {
      // The page runs like it would in a browser: no access to the computer.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Links to other sites (maps, help pages) open in the normal browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin !== officeOrigin) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== officeOrigin) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  void win.loadURL(OFFICE_URL);
}

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
