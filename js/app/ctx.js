// The 3D scene (see js/scene.js).

import { setRenderer as setModelRenderer } from '../custom-devices.js';
import { createScene } from '../scene.js';
import { state } from './state.js';
import { $ } from './util.js';

export const ctx = createScene($('stage'));
setModelRenderer(ctx.renderer);
ctx.setUnit(state.unit);
