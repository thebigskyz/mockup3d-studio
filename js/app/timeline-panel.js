// The timeline panel (see js/timeline-ui.js).

import { createTimelineUI } from '../timeline-ui.js';
import { CAMERA } from '../timeline.js';
import { play, playhead, playing, refreshPose, setTime, toggleKeyAtPlayhead } from './animation.js';
import { video } from './designs.js';
import { saveSoon } from './history.js';
import { deviceDesc, deviceName, insts } from './instances.js';
import { deselected, selectSceneDevice } from './scene-list.js';
import { anim, state } from './state.js';
import { syncTransport } from './transport.js';

/** The timeline panel; created by initTimelineUI. */
export let timelineUI = null;

export function initTimelineUI() {
  timelineUI = createTimelineUI({
    getAnim: () => anim,
    getTime: () => playhead,
    setTime: (t) => {
      if (playing) play(false);
      setTime(t);
    },
    // Camera first, then one track per device with its design underneath.
    getTracks: () => [
      { id: CAMERA, kind: 'camera', label: 'Camera' },
      ...state.devices.map((d) => {
        const m = insts.get(d.id)?.media;
        return {
          id: d.id,
          kind: 'device',
          icon: deviceDesc(d.model)?.kind === 'tablet' ? 'tablet' : 'phone',
          label: deviceName(d),
          selected: d.id === state.selected && !deselected,
          design: { kind: m ? (m.video ? 'video' : 'image') : null, name: m?.name, duration: m?.video?.duration },
        };
      }),
    ],
    selectTrack: (id) => {
      if (id !== CAMERA) selectSceneDevice(id);
    },
    toggleKey: (id) => {
      if (playing) play(false);
      toggleKeyAtPlayhead(id);
    },
    onEdit: () => {
      refreshPose();
      syncTransport();
      saveSoon();
    },
  });
}
