// The status bar message.

import { currentDevice, deviceName, sel } from './instances.js';
import { selRec, state } from './state.js';
import { $ } from './util.js';

export function setStatus(msg, kind = 'ok') {
  const dev = currentDevice();
  const n = state.devices.length;
  $('status').textContent = msg || (n > 1
    ? ['Ready', `${n} devices`, `${deviceName(selRec())} selected`]
    : ['Ready', dev.label, sel().media?.name]).filter(Boolean).join(' · ');
  $('statusDot').className = 'dot' + (kind === 'ok' ? '' : ' ' + kind);
}
