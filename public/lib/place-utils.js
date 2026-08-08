/* Shared place-name parsing helpers — used by both the admin dashboard
   (app.js, for the location choropleth) and the member profile page
   (profile.js, for the "City in USA" field on the digital card). Kept in one
   file so both stay in sync instead of drifting.

   Real member data is messy: "1040 Pittman Dr., Gallatin 37066" (no comma
   before the zip), "117 Brighton lane, Lebanon, TN, 37090" (zip as its own
   segment), "816 Georgebro ct" (street only, no city at all), native places
   like "Idukki (Kerala)" or "Alleppey Kerala" (state glued on with no comma).
   These helpers do their best to pull out just the place name so it buckets
   consistently instead of showing raw address fragments. */

const US_STATE_ABBR = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
]);
const STREET_SUFFIX_RE = /^(dr|drive|rd|road|ln|lane|ct|court|st|street|ave|avenue|blvd|boulevard|cir|circle|ter|terrace|terr|pl|place|way|pkwy|parkway|trl|trail|hwy|highway|sq|square|xing|crossing|pass|run|walk|path|loop|row|pike|apt|unit|suite|ste)\.?$/i;

function stripTrailingZip(s) {
  return s.replace(/\s*\b\d{4,6}(-\d{4})?\s*$/, "").trim();
}
function stripTrailingState(s) {
  const m = s.match(/^(.*?)[\s,]+([A-Za-z]{2})$/);
  if (m && US_STATE_ABBR.has(m[2].toUpperCase())) return m[1].trim();
  const m2 = s.match(/^(.*?)[\s,]+(tennessee)$/i);
  if (m2) return m2[1].trim();
  return s;
}
function isBareState(s) {
  const t = String(s).trim();
  return US_STATE_ABBR.has(t.toUpperCase()) || /^tennessee$/i.test(t);
}
function looksLikeStreetFragment(s) {
  if (!s) return true;
  const trimmed = s.trim();
  if (/^\d/.test(trimmed)) return true; // starts with a house number
  const lastWord = trimmed.split(/\s+/).pop();
  return STREET_SUFFIX_RE.test(lastWord);
}

// Collates place names written with different amounts of detail (e.g. "Kochi",
// "Kochi, Kerala" and "Idukki (Kerala)" all reduce to just the primary name).
function normalizePlaceKey(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.split(",")[0].split("/")[0].trim();
  s = s.replace(/\([^)]*\)/g, "").trim();
  s = s.replace(/\b(kerala|dist\.?|district)\s*$/i, "").trim();
  s = s.replace(/\s+/g, " ");
  return s || null;
}

function extractUsCityName(address) {
  if (!address) return null;
  let s = String(address).trim();
  if (!s) return null;
  s = s.replace(/,?\s*(USA|U\.S\.A\.?|United States|US)\s*$/i, "").trim();
  const parts = s.split(",").map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  if (parts.length === 1) {
    const candidate = stripTrailingState(stripTrailingZip(parts[0]));
    if (!candidate || isBareState(candidate) || looksLikeStreetFragment(candidate) || /^tennessee$/i.test(candidate)) return null;
    return normalizePlaceKey(candidate);
  }

  let idx = parts.length - 1;
  while (idx >= 0 && (/^\d{5}(-\d{4})?$/.test(parts[idx]) || isBareState(parts[idx]))) idx--;
  for (; idx >= 0; idx--) {
    const candidate = stripTrailingState(stripTrailingZip(parts[idx]));
    if (candidate && !isBareState(candidate) && !looksLikeStreetFragment(candidate)) {
      return normalizePlaceKey(candidate);
    }
  }
  return null;
}
