/** Terminal webhook va poller bir xil WebSocket push funksiyasidan foydalanadi. */
let broadcastFn = null;

export function setAttendanceBroadcastHub(fn) {
  broadcastFn = typeof fn === "function" ? fn : null;
}

export function emitAttendanceBroadcast(payload) {
  if (broadcastFn) broadcastFn(payload);
}
