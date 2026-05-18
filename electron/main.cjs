const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const devServer = process.env.CULTCACHE_INSPECTOR_DEV_SERVER;
app.setName("Huginn");
const logPath = path.join(app.getPath("userData"), "huginn-renderer.log");

function writeLog(message) {
  const line = `[${new Date().toISOString()}] ${message}${os.EOL}`;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line);
  } catch {
    // Logging must never be the reason the inspector refuses to open.
  }
  console.log(line.trimEnd());
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 820,
    minHeight: 560,
    title: "Huginn",
    icon: path.join(__dirname, "..", "dist-inspector", "hugin-64.png"),
    backgroundColor: "#05090d",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    writeLog(`renderer console[${level}] ${sourceId}:${line} ${message}`);
  });
  window.webContents.on("did-fail-load", (_event, code, description, validatedUrl) => {
    writeLog(`renderer failed load ${code} ${description} ${validatedUrl}`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    writeLog(`renderer process gone ${details.reason} exitCode=${details.exitCode}`);
  });
  window.webContents.on("did-finish-load", () => {
    writeLog(`renderer loaded ${window.webContents.getURL()}`);
  });

  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(path.join(__dirname, "..", "dist-inspector", "index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
