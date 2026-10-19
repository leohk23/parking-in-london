// Recent destinations, kept in this browser only (localStorage), newest first.

const KEY = 'park-nearby:recent';
const MAX = 6;

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // Storage can be blocked, e.g. in some private-browsing modes.
  }
}

export function loadRecent(storage = defaultStorage()) {
  try {
    const list = JSON.parse(storage?.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((p) => p?.label && Array.isArray(p.point)) : [];
  } catch {
    return [];
  }
}

/** Adds a place ({ label, point, street }) to the front, dropping an older copy of the same name. */
export function addRecent(place, storage = defaultStorage()) {
  if (!place?.label || !place.point) return;
  const key = place.label.trim().toLowerCase();
  const list = [
    { label: place.label, point: place.point, street: place.street ?? null },
    ...loadRecent(storage).filter((p) => p.label.trim().toLowerCase() !== key),
  ].slice(0, MAX);
  try {
    storage?.setItem(KEY, JSON.stringify(list));
  } catch {
    // Full or blocked storage just means no history.
  }
}

export function clearRecent(storage = defaultStorage()) {
  try {
    storage?.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
