import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "contacts.db");

export function initDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      given_name TEXT,
      surname TEXT,
      company_name TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS phones (
      contact_id TEXT NOT NULL,
      type TEXT NOT NULL,
      phone TEXT NOT NULL,
      phone_normalized TEXT NOT NULL,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_phones_normalized ON phones(phone_normalized)
  `);

  return db;
}

function normalize(phone) {
  if (!phone) return null;
  return phone.replace(/\D/g, "");
}

export function upsertContact(db, contact) {
  const upsertStmt = db.prepare(`
    INSERT INTO contacts (id, display_name, given_name, surname, company_name, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      given_name = excluded.given_name,
      surname = excluded.surname,
      company_name = excluded.company_name,
      updated_at = datetime('now')
  `);

  const deletePhones = db.prepare("DELETE FROM phones WHERE contact_id = ?");
  const insertPhone = db.prepare(
    "INSERT INTO phones (contact_id, type, phone, phone_normalized) VALUES (?, ?, ?, ?)",
  );

  // Collect all phone numbers with their type
  const allPhones = [];
  if (contact.mobilePhone) {
    allPhones.push({ type: "mobile", phone: contact.mobilePhone });
  }
  for (const p of contact.businessPhones || []) {
    allPhones.push({ type: "business", phone: p });
  }
  for (const p of contact.homePhones || []) {
    allPhones.push({ type: "home", phone: p });
  }

  upsertStmt.run(
    contact.id,
    contact.displayName,
    contact.givenName || null,
    contact.surname || null,
    contact.companyName || null,
  );

  deletePhones.run(contact.id);
  for (const { type, phone } of allPhones) {
    const norm = normalize(phone);
    if (norm) insertPhone.run(contact.id, type, phone, norm);
  }
}

export function deleteContactsNotIn(db, ids) {
  if (ids.length === 0) {
    db.exec("DELETE FROM phones");
    db.exec("DELETE FROM contacts");
    return;
  }
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM phones WHERE contact_id NOT IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM contacts WHERE id NOT IN (${placeholders})`).run(...ids);
}

function formatName(row, format) {
  const first = row.given_name || "";
  const last = row.surname || "";
  const company = row.company_name || "";

  let name;
  switch (format) {
    case "lastname":
      name = last && first ? `${last}, ${first}` : last || first || row.display_name;
      break;
    case "company":
      if (company && (first || last)) {
        const fullName = [first, last].filter(Boolean).join(" ");
        return `${company} (${fullName})`;
      }
      name = company || row.display_name;
      break;
    default: // "firstname"
      name = [first, last].filter(Boolean).join(" ") || row.display_name;
      break;
  }

  if (format !== "company" && company) {
    name = `${name} (${company})`;
  }

  return name;
}

export function findByPhone(db, phone, nameFormat = "firstname") {
  const normalized = normalize(phone);
  if (!normalized) return null;

  const row = db.prepare(`
    SELECT c.display_name, c.given_name, c.surname, c.company_name, p.phone, p.type
    FROM phones p
    JOIN contacts c ON c.id = p.contact_id
    WHERE p.phone_normalized LIKE ?
    LIMIT 1
  `).get(`%${normalized}%`);

  if (!row) return null;

  return {
    name: formatName(row, nameFormat),
    phone: row.phone,
    phoneType: row.type,
  };
}
