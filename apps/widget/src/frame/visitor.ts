import {generateVisitorId} from '../shared/protocol';

const STORAGE_KEY = 'plunk_messenger_visitor';

/* Only used when the frame is opened on its own. Embedded, the loader owns the visitor id because
third-party storage inside an iframe is partitioned or blocked by Safari. */
export function standaloneVisitorId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) {
      return existing;
    }
    const created = generateVisitorId();
    localStorage.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    return generateVisitorId();
  }
}
