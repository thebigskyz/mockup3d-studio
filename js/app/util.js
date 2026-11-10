// Small helpers shared by the app modules.


export const $ = (id) => document.getElementById(id);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
export const isTypingTarget = (el) => !!el?.matches?.('input:not([type=range]):not([type=checkbox]):not([type=color]), textarea, [contenteditable]');
export function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
