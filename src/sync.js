import { fetchContacts } from "./graph.js";
import { upsertContact, deleteContactsNotIn } from "./db.js";

export async function syncContacts(db, config) {
  console.log(`[sync] Starting contact sync from ${config.mailbox}...`);
  const start = Date.now();

  const contacts = await fetchContacts(config);
  console.log(`[sync] Fetched ${contacts.length} contacts from Graph API`);

  const ids = [];
  for (const contact of contacts) {
    upsertContact(db, contact);
    ids.push(contact.id);
  }

  deleteContactsNotIn(db, ids);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[sync] Sync complete in ${elapsed}s — ${contacts.length} contacts stored`);

  return { contactCount: contacts.length, duration: parseFloat(elapsed) };
}

export function startPeriodicSync(db, config, intervalMinutes, onSyncComplete) {
  const runSync = async () => {
    try {
      const result = await syncContacts(db, config);
      if (onSyncComplete) onSyncComplete(null, result);
    } catch (err) {
      console.error("[sync] Sync failed:", err.message);
      if (onSyncComplete) onSyncComplete(err, null);
    }
  };

  // Run initial sync
  runSync();

  // Schedule recurring sync
  const ms = intervalMinutes * 60 * 1000;
  const timer = setInterval(runSync, ms);

  console.log(`[sync] Scheduled sync every ${intervalMinutes} minute(s)`);
  return timer;
}
