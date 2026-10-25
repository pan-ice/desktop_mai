const assert = require("node:assert/strict");
const { realpathSync } = require("node:fs");
const { resolve } = require("node:path");
const { app, shell } = require("electron");

const [expected, ...shortcuts] = process.argv.slice(2);
app.disableHardwareAcceleration();
app.setPath("userData", resolve(".cache/installer-smoke/shortcut-reader"));

app.whenReady().then(() => {
  assert.ok(expected && shortcuts.length, "Pass the installed executable and shortcuts");
  for (const link of shortcuts) {
    // Read through the Unicode Windows Shell API. WScript.Shell can return an
    // empty target for shortcut filenames outside the system ANSI code page.
    const details = shell.readShortcutLink(link);
    assert.equal(
      realpathSync.native(details.target).toLowerCase(),
      realpathSync.native(expected).toLowerCase(),
      `Incorrect shortcut target: ${link} -> ${details.target}`,
    );
    assert.equal(details.args, "", `Unexpected shortcut arguments: ${link}`);
    console.log(`PASS shortcut: ${link} -> ${details.target}`);
  }
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
