// Chrome on macOS, Windows and Linux: its profile list, whether it's running, and launching it.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const platform = process.platform;

function userDataDir() {
  if (platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'google-chrome');
}

// Chrome's own names for its profiles. Empty if the file can't be read.
export function chromeProfiles() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(userDataDir(), 'Local State'), 'utf8'));
    return Object.entries(state.profile?.info_cache || {}).map(([dir, p]) => ({
      dir,
      name: p.name || dir,
      email: p.user_name || null,
    }));
  } catch {
    return [];
  }
}

export function isChromeRunning() {
  return new Promise((resolve) => {
    if (platform === 'win32') {
      execFile('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { windowsHide: true },
        (err, stdout) => resolve(!err && /chrome\.exe/i.test(stdout)));
    } else {
      execFile('pgrep', ['-x', platform === 'darwin' ? 'Google Chrome' : 'chrome'], (err) => resolve(!err));
    }
  });
}

function windowsChromePath() {
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  return roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')).find((p) => fs.existsSync(p)) ?? null;
}

function launch(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function openChrome({ url, profileDir } = {}) {
  const chromeArgs = [...(profileDir ? [`--profile-directory=${profileDir}`] : []), ...(url ? [url] : [])];
  if (platform === 'darwin') {
    const args = profileDir ? ['-na', 'Google Chrome', '--args', ...chromeArgs] : ['-a', 'Google Chrome', ...chromeArgs];
    return new Promise((resolve, reject) => execFile('open', args, (err) => (err ? reject(err) : resolve())));
  }
  if (platform === 'win32') {
    const exe = windowsChromePath();
    if (exe) return launch(exe, chromeArgs);
    // Chrome not in a standard place: let Windows find it, or fall back to the default browser.
    return launch('cmd', ['/c', 'start', '""', 'chrome', ...chromeArgs]).catch(() => url && launch('cmd', ['/c', 'start', '""', url]));
  }
  return launch('google-chrome', chromeArgs).catch(() => url && launch('xdg-open', [url]));
}
