const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const devServer = process.env.CULTCACHE_INSPECTOR_DEV_SERVER;

function createWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 820,
    minHeight: 560,
    title: "CultCache Inspector",
    backgroundColor: "#f4f2ea",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
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
