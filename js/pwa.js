// Installing Mockup3D Studio as an app (PWA): registers the service worker
// (offline use) and shows an "Install app" button where the browser can
// install it.
//
// - Chrome / Edge fire `beforeinstallprompt`: the button opens their install
//   dialog.
// - Safari has no install API: the button explains its own menu command
//   (File → Add to Dock on a Mac, Share → Add to Home Screen on iPad).
// - Already running as an installed app, or a browser that can't install
//   apps (Firefox): no button.

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered:', err));
  });
}

const $ = (id) => document.getElementById(id);
const box = $('install');
const btn = $('installBtn');
const hint = $('installHint');

const installed = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ua = navigator.userAgent;
const isSafari = /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|FxiOS|Firefox|Android/.test(ua);
const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let deferred = null; // Chrome / Edge's saved install prompt

function show(on) {
  box.hidden = !on || installed();
  if (box.hidden) hint.hidden = true;
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // use our button instead of the browser's mini-bar
  deferred = e;
  show(true);
});

window.addEventListener('appinstalled', () => {
  deferred = null;
  show(false);
});

if (isSafari && !installed()) {
  hint.innerHTML = isIOS
    ? 'Tap <b>Share</b>, then <b>Add to Home Screen</b>. Mockup3D Studio then opens from its own icon, full screen, and works offline.'
    : 'In Safari’s menu bar, choose <b>File → Add to Dock</b>. Mockup3D Studio then opens in its own window from the Dock, and works offline. (Needs macOS Sonoma or later.)';
  show(true);
}

btn.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (deferred) {
    const prompt = deferred;
    deferred = null; // a prompt can only be used once
    prompt.prompt();
    await prompt.userChoice;
    // Either way the prompt is spent. If declined, Chrome fires
    // beforeinstallprompt again later, which brings the button back.
    show(false);
    return;
  }
  hint.hidden = !hint.hidden;
});

document.addEventListener('click', (e) => {
  if (!hint.hidden && !box.contains(e.target)) hint.hidden = true;
});
window.matchMedia('(display-mode: standalone)').addEventListener?.('change', () => show(!box.hidden));
