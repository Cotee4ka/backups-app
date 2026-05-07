import { app, BrowserWindow, dialog, ipcMain, safeStorage, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { registerIpc } from './ipc';
import { getServerStore } from './store';
import { fingerprintFromCertObject } from './tls-pin';

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;

const certWaiters = new Map<string, Promise<boolean>>();

async function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0c0d13',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());

  if (isDev && VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

/**
 * Critical: TLS fingerprint pinning.
 *
 * Серверы пользователей используют self-signed сертификаты, поэтому стандартная
 * проверка PKI обрушит соединение. Вместо глобального отключения мы сравниваем
 * SHA-256 fingerprint сертификата с сохранённым в safeStorage при первой
 * установке (мастер «Создать сервер»).
 */
app.on('certificate-error', (event, _webContents, url, _error, certificate, callback) => {
  try {
    const u = new URL(url);
    const origin = `${u.protocol}//${u.host}`;
    const store = getServerStore();
    const known = store.getServerByOrigin(origin);
    const presentFp = fingerprintFromCertObject(certificate);

    if (known && presentFp && known.fingerprint && safeEqual(known.fingerprint, presentFp)) {
      event.preventDefault();
      callback(true);
      return;
    }

    if (!known) {
      // Проверка во время первичной установки/добавления сервера: явно
      // зарегистрированный «pending» fingerprint (см. setPendingFingerprint).
      const pending = store.getPendingFingerprint(origin);
      if (pending && presentFp && safeEqual(pending, presentFp)) {
        event.preventDefault();
        callback(true);
        return;
      }
    }

    // Если попали сюда — fingerprint неизвестен или не совпадает.
    // Спрашиваем пользователя.
    askUserAboutCert(origin, presentFp, known?.fingerprint ?? null)
      .then((accept) => {
        if (accept && presentFp) {
          store.setPendingFingerprint(origin, presentFp);
          event.preventDefault();
          callback(true);
        } else {
          callback(false);
        }
      })
      .catch(() => callback(false));
  } catch {
    callback(false);
  }
});

function safeEqual(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/[^0-9a-f]/g, '');
  const y = b.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function askUserAboutCert(
  origin: string,
  presented: string | null,
  known: string | null,
): Promise<boolean> {
  const cached = certWaiters.get(origin);
  if (cached) return cached;

  const p = (async () => {
    if (!mainWindow) return false;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Отмена', 'Доверять и сохранить'],
      defaultId: 0,
      cancelId: 0,
      title: 'Неизвестный TLS сертификат',
      message: known
        ? `Сертификат сервера ${origin} ИЗМЕНИЛСЯ. Возможна атака MITM.`
        : `Сертификат сервера ${origin} не закреплён.`,
      detail: [
        known ? `Старый: ${known}` : 'Старого fingerprint нет.',
        `Новый: ${presented ?? '—'}`,
        '',
        'Доверяйте только если сами что-то меняли на сервере.',
      ].join('\n'),
    });
    return response === 1;
  })();
  certWaiters.set(origin, p);
  p.finally(() => certWaiters.delete(origin));
  return p;
}

app.whenReady().then(async () => {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[security] safeStorage encryption is not available; falling back to plaintext file');
  }
  registerIpc(() => mainWindow);
  await createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Если приложение запускается с CLI-аргументом /minimized (autoLaunch), просто прячем окно.
if (process.argv.includes('--hidden')) {
  app.on('browser-window-created', (_e, w) => {
    w.hide();
  });
}

// log unhandled rejections in main
process.on('unhandledRejection', (e) => {
  console.error('unhandledRejection in main:', e);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'main-error.log'), `\n${new Date().toISOString()} ${String(e)}`);
  } catch {
    /* noop */
  }
});
