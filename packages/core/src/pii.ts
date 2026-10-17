// packages/core/src/pii.ts
// Personal data that must never reach disk, removed at the door.
//
// ═══ WHY THIS EXISTS ═══
// The product counts people; it does not need to know who they are. But event
// properties are free-form, and the easiest mistake in analytics is
// `vitrus.identify(user.id, { email: user.email })` — written once, stored
// forever. A privacy notice cannot undo a row that was written.
//
// Two rules, applied to EVERY event's properties (and mirrored in the tracker,
// so in the normal case the value never leaves the browser at all):
//
//   1. Keys that name personal data are dropped: email, phone, first/last
//      name, address, password, token, IP, date of birth, card, IBAN, national
//      id. Matched on the whole key, case- and separator-insensitive — so
//      `Email`, `e_mail` and `user-email` go, while `email_opt_in` (a boolean
//      about a person, not their address) and `plan_name` stay.
//   2. Values that LOOK like an email address or an international phone
//      number are dropped whatever their key — `{ contact: "a@b.com" }` is
//      caught too.
//
// The event itself is kept: only the property goes. How many were removed is
// recorded in `_pii_dropped`, so the dashboard can say "3 properties carried
// personal data and were not stored" instead of quietly storing less.
//
// Known blind spots, written down:
//   * A name in a free-text value ("note: call Maria") is not detected. Free
//     text is not a field this product asks for anywhere.
//   * Phone numbers are recognised only in international form (+90 532 …).
//     A bare 10-digit string is indistinguishable from an order id, and
//     dropping order ids would break revenue and goals.
//   * A national id under an innocent key (`ref: "12345678901"`) is not
//     detected, for the same reason.

const KEY_DENY = new Set([
  "email", "mail", "emailaddress", "useremail", "customeremail",
  "phone", "phonenumber", "mobile", "mobilephone", "tel", "telephone", "gsm",
  "firstname", "lastname", "fullname", "surname", "givenname", "familyname", "displayname", "realname",
  "address", "streetaddress", "street", "homeaddress", "billingaddress", "shippingaddress",
  "password", "passwd", "pass", "pwd",
  "token", "accesstoken", "refreshtoken", "idtoken", "authtoken", "sessiontoken", "secret", "apikey", "apisecret",
  "ip", "ipaddress", "userip", "clientip",
  "dob", "dateofbirth", "birthdate", "birthday",
  "card", "cardnumber", "creditcard", "ccnumber", "cvv", "cvc", "iban",
  "ssn", "tckn", "tckimlik", "tckimlikno", "nationalid", "passport", "passportnumber", "taxid",
]);

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[A-Za-z]{2,}$/;
// "+" then 8–15 digits, optionally separated by spaces, dashes, dots or parentheses.
const PHONE = /^\+[\d\s().-]{8,22}$/;

/** The key with case and separators folded away: "User-Email" → "useremail". */
function fold(key: string): string {
  return key.toLowerCase().replace(/[\s_.-]/g, "");
}

export function isPersonalKey(key: string): boolean {
  return KEY_DENY.has(fold(key));
}

export function isPersonalValue(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (EMAIL.test(s)) return true;
  if (PHONE.test(s)) {
    const digits = s.replace(/\D/g, "").length;
    return digits >= 8 && digits <= 15;
  }
  return false;
}

/**
 * Remove personal data from a property bag, in place. Returns how many
 * properties were removed. Internal keys (leading "_") are the server's own
 * and are left alone.
 */
export function scrubProps(props: Record<string, string | number | boolean | null>): number {
  let dropped = 0;
  for (const k of Object.keys(props)) {
    if (k.startsWith("_")) continue;
    if (isPersonalKey(k) || isPersonalValue(props[k])) {
      delete props[k];
      dropped++;
    }
  }
  return dropped;
}

/**
 * Plans: a short label the site owner chooses ("free", "pro", "team").
 *
 * Normalised to lower case and to a closed alphabet so the lifecycle numbers
 * group cleanly — "Pro", "pro " and "PRO" are one plan. A value that is not a
 * plausible label (an email, a sentence, 200 characters) is removed and the
 * reason kept in `_plan_rejected`; the event stays.
 */
export const PLAN_MAX = 32;
export function normalizePlan(props: Record<string, string | number | boolean | null>): void {
  if (!Object.prototype.hasOwnProperty.call(props, "plan")) return;
  const raw = props.plan;
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v && v.length <= PLAN_MAX && /^[a-z0-9][a-z0-9_-]*$/.test(v)) {
    props.plan = v;
    return;
  }
  delete props.plan;
  props._plan_rejected = typeof raw === "string" ? (raw.trim() ? "plan_not_a_label" : "plan_empty") : "plan_not_a_string";
}
