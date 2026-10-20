/* Mobile-number rules per country, from Google's libphonenumber
   (libphonenumber-js). The same library the Odoo side checks with
   (`phonenumbers`, /kpi_user_access/set_mobile), so the screen and the server
   agree on what a valid number is.

   "Valid" means a real MOBILE number of that country, not just the right
   number of digits: 5123456789 is a valid Indian number, but a landline. */
import { parsePhoneNumberFromString, getExampleNumber, getCountryCallingCode } from "libphonenumber-js/max";
import examples from "libphonenumber-js/mobile/examples";

/* Plain words for the countries this install deals with; the rest get an
   example number. Mirrors kra_api._MOBILE_RULES. */
const RULES = {
  IN: "10 digits starting with 6, 7, 8 or 9",
  OM: "8 digits starting with 7 or 9",
};
const NAMES = { IN: "India", OM: "Oman" };

const example = (iso) => {
  try { return getExampleNumber(iso, examples)?.nationalNumber || ""; } catch (e) { return ""; }
};

/* Longest number to accept while typing: the example's length. */
export function maxLen(iso) { return example(iso).length || 15; }

/* "92123456" → "9212 3456" for a placeholder. */
export function placeholderFor(iso) {
  const ex = example(iso);
  return ex ? ex.replace(/(\d{4,5})(\d+)$/, "$1 $2") : "";
}

export function ruleText(iso, countryName) {
  const name = countryName || NAMES[iso] || iso;
  const ex = example(iso);
  return `${name} mobile: ${RULES[iso] || (ex ? `e.g. ${ex}` : "a mobile number of that country")}`;
}

export function dialOf(iso) {
  try { return getCountryCallingCode(iso); } catch (e) { return ""; }
}

/* digits → { ok, national } — empty is ok (clears the number). */
export function checkMobile(digits, iso) {
  const d = String(digits || "").replace(/\D/g, "");
  if (!d) return { ok: true, national: "" };
  if (!iso) return { ok: true, national: d }; /* unknown country: leave it to the server */
  const n = parsePhoneNumberFromString(d, iso);
  const type = n?.getType();
  const ok = !!n && n.country === iso && n.isValid() && (type === "MOBILE" || type === "FIXED_LINE_OR_MOBILE");
  return { ok, national: ok ? String(n.nationalNumber) : d };
}
