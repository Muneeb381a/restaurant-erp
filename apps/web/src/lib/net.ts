/**
 * Is the server reachable right now? A Wi-Fi that has no internet still says "online" to the browser, so every request
 * would wait for its own failure. After one request fails to reach the server, the next ones fail at once for a few
 * seconds (the screen answers instantly from what is on the device), then one tries the server again.
 */
const DOWN_MS = 6000;
let downUntil = 0;

export const markDown = (): void => {
  downUntil = Date.now() + DOWN_MS;
};
export const markUp = (): void => {
  downUntil = 0;
};
export const isDown = (): boolean => Date.now() < downUntil || navigator.onLine === false;
