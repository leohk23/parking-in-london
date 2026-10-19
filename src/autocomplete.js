// The dropdown under the destination box. With fewer than 3 characters typed
// it lists recent searches; after that, suggestions appear 300 ms after typing
// stops. Arrow keys move, Enter picks, Escape closes. Picking calls onPick
// with { label, point, street }.

import { fetchSuggestions } from './suggest.js';

const PIN_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.5" fill="currentColor"/></svg>';
const CLOCK_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/** `recent` is { load(), clear() } for the recent-searches list. */
export function attachSuggestions(input, list, { onPick, recent, fetchImpl, delayMs = 300 } = {}) {
  let items = [];
  let showingRecent = false;
  let active = -1;
  let timer;
  let controller;
  let pickedLabel = null;

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');
  list.setAttribute('role', 'listbox');

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const show = (html) => {
    list.innerHTML = html;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  const renderItems = () => {
    if (!items.length) {
      return show('<li class="suggestion-note">No suggestions found. Can\'t find it? Long-press the map to drop a pin.</li>');
    }
    const icon = showingRecent ? CLOCK_ICON : PIN_ICON;
    show(
      (showingRecent ? '<li class="suggestion-heading" role="presentation">Recent</li>' : '') +
        items
          .map(
            (item, i) =>
              `<li id="${list.id}-${i}" role="option" class="suggestion${i === active ? ' active' : ''}" aria-selected="${i === active}" data-index="${i}">${icon}<span>${escapeHtml(item.label)}</span></li>`,
          )
          .join('') +
        (showingRecent ? '<li class="suggestion-clear" role="presentation"><button type="button" data-action="clear">Clear recent searches</button></li>' : ''),
    );
    if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
  };

  const showRecent = () => {
    items = recent?.load() ?? [];
    showingRecent = true;
    active = -1;
    if (items.length) renderItems();
    else close();
  };

  const pick = (item) => {
    input.value = item.label;
    pickedLabel = item.label;
    items = [];
    close();
    onPick?.(item);
  };

  input.addEventListener('input', () => {
    pickedLabel = null;
    clearTimeout(timer);
    controller?.abort();
    const q = input.value.trim();
    if (q.length < 3) return showRecent();
    if (showingRecent || !items.length) {
      items = [];
      showingRecent = false;
      show('<li class="suggestion-note">Searching…</li>');
    }
    timer = setTimeout(async () => {
      controller = new AbortController();
      let found;
      try {
        found = await fetchSuggestions(q, { fetchImpl, signal: controller.signal });
      } catch (err) {
        if (err.name === 'AbortError') return;
        found = [];
      }
      if (input.value.trim() !== q || document.activeElement !== input) return;
      items = found;
      showingRecent = false;
      active = -1;
      renderItems();
    }, delayMs);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden || !items.length) {
      if (e.key === 'Escape') close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = e.key === 'ArrowDown' ? Math.min(active + 1, items.length - 1) : Math.max(active - 1, -1);
      renderItems();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  input.addEventListener('focus', () => {
    const q = input.value.trim();
    if (q.length < 3) showRecent();
    else if (items.length && q !== pickedLabel) renderItems();
  });
  input.addEventListener('blur', () => setTimeout(close, 150));

  // pointerdown rather than click, so picking works before the input's blur closes the list.
  list.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-action="clear"]')) {
      e.preventDefault();
      recent?.clear();
      items = [];
      return close();
    }
    const option = e.target.closest('[data-index]');
    if (!option) return;
    e.preventDefault();
    pick(items[Number(option.dataset.index)]);
  });

  return { close };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
