'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { previewSmoke } = require('../lib/tools/preview-smoke');

const PIXELS = Buffer.from('fake-png');

function fakeElectron({ ready }) {
  const windows = [];
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.webContents = {
        on: () => {},
        executeJavaScript: async (code) => {
          if (code.includes('state().ready')) return ready;
          if (code.includes('toDataURL')) return `data:image/png;base64,${PIXELS.toString('base64')}`;
          if (code.includes('uiTree')) return { state: { turn: 1 }, uiTree: [{ role: 'hand-card' }], actions: [] };
          return { top: 0, width: 1170, height: 540 };
        },
      };
      windows.push(this);
    }
    async loadURL() {}
    setContentSize() {}
    destroy() { this.destroyed = true; }
  }
  return { electron: { BrowserWindow }, windows };
}

test('hidden target returns the probe result and the canvas pixels, then closes its window', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
  const { electron, windows } = fakeElectron({ ready: true });

  const result = await previewSmoke({ width: 1170, height: 540, settleMs: 0 }, { electron, projectPath });

  assert.equal(result.ok, true);
  assert.deepEqual(result.state, { turn: 1 });
  assert.equal(result.uiTree[0].role, 'hand-card');
  assert.deepEqual(fs.readFileSync(result.screenshot), PIXELS);
  assert.equal(windows[0].options.show, false);
  assert.equal(windows[0].destroyed, true);
});

test('a preview that never becomes ready is a structured failure and does not leak its window', async () => {
  const { electron, windows } = fakeElectron({ ready: false });

  const result = await previewSmoke({ readyTimeoutMs: 1 }, { electron, projectPath: os.tmpdir() });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'never_ready');
  assert.equal(windows[0].destroyed, true);
});
