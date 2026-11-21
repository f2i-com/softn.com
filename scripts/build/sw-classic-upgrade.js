/** Previous Runtime versions stored the engine and any lazy component names on the
 * offline record. Before format was recorded, web installs always recorded a container tier. */
export function previousClassicGroups(record, componentTags) {
  if (!record.offline?.ready || record.format === 'web') return [];
  const features = record.offline.features ?? [];
  if (!record.format && features.some((name) => name.startsWith('engine:') && name !== 'engine:full')) return [];
  const groups = new Set(['renderer']);
  for (const name of features) {
    if (name === 'engine:full') groups.add('script');
    else if (Object.hasOwn(componentTags, name)) groups.add(componentTags[name]);
  }
  return [...groups];
}

/** Read one record at a time. Never change the app database or retain its archive bytes. */
export function installedClassicGroups(indexedDB, componentTags, scan) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('softn-web');
    let absent = false;
    open.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) {
        absent = true;
        open.transaction.abort();
      }
    };
    open.onerror = () => absent ? resolve([]) : reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('softn-apps')) { db.close(); resolve([]); return; }
      const tx = db.transaction('softn-apps');
      const groups = new Set();
      const read = tx.objectStore('softn-apps').openCursor();
      read.onsuccess = () => {
        const cursor = read.result;
        if (!cursor) return;
        const record = cursor.value;
        const known = previousClassicGroups(record, componentTags);
        for (const group of known) groups.add(group);
        if (known.length && !record.offline.allPages && record.bundleData) {
          for (const group of scan(record.bundleData, componentTags)) groups.add(group);
        }
        cursor.continue();
      };
      tx.oncomplete = () => { db.close(); resolve([...groups]); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
