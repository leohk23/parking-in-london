// Saved places, kept in this browser only (localStorage), newest first. Unlike
// recent searches they stay until you remove them.

const KEY = 'park-nearby:saved';

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // Storage can be blocked, e.g. in some private-browsing modes.
  }
}

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function loadSaved(storage = defaultStorage()) {
  try {
    const list = JSON.parse(storage?.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((p) => p?.label && Array.isArray(p.point)) : [];
  } catch {
    return [];
  }
}

export function isSaved(place, storage = defaultStorage()) {
  return Boolean(place?.label) && loadSaved(storage).some((p) => sameName(p.label, place.label));
}

function write(list, storage) {
  if (!storage) return false;
  try {
    storage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false; // Full or blocked storage: nothing saved.
  }
}

/** Saves a place ({ label, point, street }) at the top; returns whether it could be saved. */
export function savePlace(place, storage = defaultStorage()) {
  if (!place?.label || !place.point) return false;
  const list = [{ label: place.label, point: place.point, street: place.street ?? null }, ...loadSaved(storage).filter((p) => !sameName(p.label, place.label))];
  return write(list, storage);
}

export function removeSaved(label, storage = defaultStorage()) {
  write(loadSaved(storage).filter((p) => !sameName(p.label, label)), storage);
}
