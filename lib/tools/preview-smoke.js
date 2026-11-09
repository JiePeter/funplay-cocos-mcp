'use strict';

const fs = require('fs');
const path = require('path');

const PREVIEW_URL = 'http://localhost:7456/?autoReload=false';
const READY_PROBE = '!!(window.__agent && window.__agent.state().ready)';
const CANVAS_GEOMETRY = `(function(){
  var c = document.querySelector('canvas');
  if (!c) return null;
  var r = c.getBoundingClientRect();
  return { top: r.top, width: r.width, height: r.height, bufferWidth: c.width, bufferHeight: c.height };
})()`;

// WebGL clears its drawing buffer after compositing, and a hidden window's capturePage returns black, so the
// pixels are read inside the frame that drew them.
const CAPTURE_CANVAS = `new Promise(function (resolve) {
  var timer = setTimeout(function () { resolve(null); }, 3000);
  cc.director.once(cc.Director.EVENT_AFTER_DRAW, function () {
    clearTimeout(timer);
    resolve(cc.game.canvas.toDataURL('image/png'));
  });
})`;

function driveScript(scenario, actions) {
  return `(function (scenario, actions) {
    var a = window.__agent;
    var brief = function (r) { return { ok: !!(r && r.ok !== false), error: (r && r.error) || undefined }; };
    var reset = scenario ? brief(a.reset({ scenario: scenario })) : undefined;
    var acts = actions.map(function (x) { return brief(a.act(x)); });
    var s = a.state();
    var summary = {};
    Object.keys(s).forEach(function (k) { if (s[k] === null || typeof s[k] !== 'object') summary[k] = s[k]; });
    return { reset: reset, actions: acts, state: summary, uiTree: a.uiTree() };
  })(${JSON.stringify(scenario || null)}, ${JSON.stringify(actions || [])})`;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs, stepMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      // Navigation destroys the execution context; the next poll runs in the new one.
    }
    if (Date.now() >= deadline) return null;
    await delay(stepMs);
  }
}

async function findGameView(electron) {
  for (const wc of electron.webContents.getAllWebContents()) {
    if (!/3d-webview\.html/.test(wc.getURL())) continue;
    try {
      if (await wc.executeJavaScript(READY_PROBE)) return wc;
    } catch (error) {
      // A webview that is still loading is not the preview.
    }
  }
  return null;
}

function openHiddenWindow(electron, width, height, consoleErrors) {
  const win = new electron.BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false, paintWhenInitiallyHidden: true },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) consoleErrors.push(String(message).slice(0, 500));
  });
  win.loadURL(PREVIEW_URL).catch((error) => consoleErrors.push(`load failed: ${error.message}`));
  return win;
}

// Creator's preview toolbar takes page height and pins the game frame to the device it has selected, so the
// requested viewport only reaches the canvas with the toolbar gone and the frame resized.
function applyViewportScript(width, height) {
  return `(function (w, h) {
    var bar = document.querySelector('.toolbar');
    if (bar) bar.style.display = 'none';
    var frame = document.getElementById('GameDiv');
    if (frame) { frame.style.width = w + 'px'; frame.style.height = h + 'px'; }
    var ratio = cc.screen.devicePixelRatio || 1;
    cc.screen.windowSize = new cc.Size(w * ratio, h * ratio);
    return true;
  })(${Number(width)}, ${Number(height)})`;
}

async function fitCanvas(win, width, height) {
  await win.webContents.executeJavaScript(applyViewportScript(width, height));
  await waitFor(async () => {
    const now = await win.webContents.executeJavaScript(CANVAS_GEOMETRY);
    return now && Math.abs(now.height - height) <= 1 && Math.abs(now.width - width) <= 1;
  }, 1500, 50);
}

function failure(code, message, consoleErrors) {
  return { ok: false, code, message, consoleErrors };
}

async function previewSmoke(args, { electron, projectPath }) {
  const target = args.target || 'hidden';
  const width = args.width || 1280;
  const height = args.height || 720;
  const readyTimeoutMs = args.readyTimeoutMs || 20000;
  const consoleErrors = [];
  const startedAt = Date.now();
  let win = null;

  try {
    let contents;
    if (target === 'gameView') {
      contents = await findGameView(electron);
      if (!contents) return failure('preview_not_running', 'No Game View preview with window.__agent is running.', consoleErrors);
    } else {
      win = openHiddenWindow(electron, width, height, consoleErrors);
      contents = win.webContents;
      const ready = await waitFor(() => contents.executeJavaScript(READY_PROBE), readyTimeoutMs, 250);
      if (!ready) return failure('never_ready', `window.__agent was not ready within ${readyTimeoutMs} ms at ${PREVIEW_URL}.`, consoleErrors);
      await fitCanvas(win, width, height);
    }
    const readyMs = Date.now() - startedAt;

    const driven = await contents.executeJavaScript(driveScript(args.scenario, args.actions));
    await delay(args.settleMs === undefined ? 300 : args.settleMs);

    const dataUrl = await contents.executeJavaScript(CAPTURE_CANVAS);
    if (!dataUrl) return { ...failure('capture_failed', 'No frame was drawn within 3000 ms.', consoleErrors), ...driven };

    const outputDir = path.join(projectPath, 'temp', 'mcp-captures');
    fs.mkdirSync(outputDir, { recursive: true });
    const screenshot = path.join(outputDir, path.basename(args.fileName || `preview-smoke-${target}.png`));
    fs.writeFileSync(screenshot, Buffer.from(dataUrl.split(',')[1], 'base64'));

    return {
      ok: true,
      target,
      readyMs,
      canvas: await contents.executeJavaScript(CANVAS_GEOMETRY),
      consoleErrors,
      ...driven,
      screenshot,
    };
  } finally {
    if (win) win.destroy();
  }
}

function createPreviewSmokeTool({ createSchema, getProjectPath }) {
  return {
    name: 'preview_smoke',
    profile: 'full',
    description: '[core] In one call, load a preview (hidden window, or the running Game View), optionally reset a scenario and replay actions through window.__agent, then return console errors, a state summary, uiTree and a canvas screenshot path under temp/mcp-captures.',
    inputSchema: createSchema(
      {
        target: { type: 'string', enum: ['hidden', 'gameView'], description: 'hidden (default) opens a throwaway window at the given viewport; gameView drives the running editor preview.' },
        width: { type: 'number', description: 'Hidden window canvas width in CSS pixels. Defaults to 1280.' },
        height: { type: 'number', description: 'Hidden window canvas height in CSS pixels. Defaults to 720.' },
        scenario: { type: 'string', description: 'Scenario name passed to __agent.reset.' },
        actions: { type: 'array', items: { type: 'object' }, description: 'Actions replayed through __agent.act after the reset.' },
        fileName: { type: 'string', description: 'Screenshot file name under temp/mcp-captures. Defaults to preview-smoke-<target>.png.' },
        settleMs: { type: 'number', description: 'Wait before the capture, for layout and asset loads. Defaults to 300.' },
        readyTimeoutMs: { type: 'number', description: 'How long a hidden window may take to expose a ready __agent. Defaults to 20000.' },
      },
      []
    ),
    handler: async (args) => previewSmoke(args, { electron: require('electron'), projectPath: getProjectPath() }),
  };
}

module.exports = { createPreviewSmokeTool, previewSmoke };
