// A small expiring cache in this browser's localStorage, for slow sources whose
// data rarely changes. Failures (full or blocked storage) just mean no caching.

export function createCache(name, { maxAgeMs, maxEntries = 8, storage = defaultStorage() } = {}) {
  const prefix = `park-nearby:${name}`;
  const indexKey = `${prefix}:index`;
  const itemKey = (key) => `${prefix}:${hash(key)}`;
  const readIndex = () => {
    try {
      const index = JSON.parse(storage?.getItem(indexKey) ?? '[]');
      return Array.isArray(index) ? index : [];
    } catch {
      return [];
    }
  };

  return {
    get(key) {
      try {
        const entry = JSON.parse(storage?.getItem(itemKey(key)) ?? 'null');
        if (!entry || entry.key !== key || Date.now() - entry.savedAt > maxAgeMs) return null;
        return entry.value;
      } catch {
        return null;
      }
    },
    set(key, value) {
      if (!storage) return;
      const id = itemKey(key);
      const index = [id, ...readIndex().filter((x) => x !== id)];
      try {
        for (const old of index.slice(maxEntries)) storage.removeItem(old);
        storage.setItem(indexKey, JSON.stringify(index.slice(0, maxEntries)));
        storage.setItem(id, JSON.stringify({ key, savedAt: Date.now(), value }));
      } catch {
        // Too big or storage blocked: skip caching this one.
      }
    },
  };
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// djb2, enough to give each cached query its own storage slot.
function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
