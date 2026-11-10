// electron-builder afterSign hook (macOS).
// Ad-hoc signing makes the app's "designated requirement" a hash of this exact build, so after every update macOS
// treats openVideo as a new app: Screen Recording / Camera / Microphone grants stop applying and the keychain asks
// again. Re-sign the outer bundle with a requirement based on the bundle id instead, so grants survive updates.
// Remove this once builds are signed with an Apple Developer ID (that gives a stable identity by itself).
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { productFilename, id } = context.packager.appInfo;
  const app = path.join(context.appOutDir, `${productFilename}.app`);
  execFileSync('codesign', [
    '--force', '--sign', '-', '--options', 'runtime',
    '--entitlements', path.join(__dirname, 'entitlements.mac.plist'),
    '-r', `=designated => identifier "${id}"`,
    app,
  ], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
