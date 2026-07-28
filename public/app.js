/* KAN Membership Tracker — hosted (Supabase) version
   Data lives in a shared Supabase Postgres database instead of localStorage.
   Email sends for real, through the send-email Edge Function → Brevo.
   SMS still opens your phone's Messages app — there's no free way to send
   arbitrary SMS automatically, so that part is unchanged from the local app.
*/

const ORG_EMAIL = "kantreasurer@gmail.com";     // CC'd on every reminder email
const SENDER_EMAIL = "manish.ravikumar@gmail.com"; // shown as the "From" on reminder emails

let supa = null;          // supabase client
let currentUser = null;   // { email }
let isAdmin = false;

let members = [];          // full in-memory dataset (camelCase, mirrors the local app's shape)
let sortState = { field: "name", dir: "asc" };
let editingId = null;

// reminder state
let reminderChannel = "email";
let reminderQueue = [];
let reminderQueueIndex = 0;
let reminderReason = null;
let reminderCampaign = "renewal";

const REMINDER_REASON_LABEL = {
  "contact-gap-phone": "missing phone",
  "contact-gap-email": "missing email",
};
const CONTACT_FIELD_LABEL = { address: "address", phone: "phone number", email: "email address" };

const DEFAULT_TEMPLATES = {
  renewal: {
    email: {
      subject: "KAN Membership Renewal Reminder",
      body:
        "Dear {{name}},\n\n" +
        "Our records show your Kerala Association of Nashville (KAN) membership (status: {{status}}) was last renewed on {{lastPaymentDate}}. We'd love to have you continue as an active member!\n\n" +
        "You can renew via Zelle to " + ORG_EMAIL + ", or reply to this email and we'll help you out.\n\n" +
        "Thank you for being part of the KAN community.\n\n" +
        "Warm regards,\nKAN Membership Team",
    },
    sms: {
      body:
        "Hi {{name}}, friendly reminder from KAN that your membership ({{status}}) needs renewal. " +
        "Renew via Zelle to " + ORG_EMAIL + ". Thank you! - KAN Membership Team",
    },
  },
  updateContact: {
    email: {
      subject: "Please help us update your KAN contact info",
      body:
        "Dear {{name}},\n\n" +
        "We don't currently have your {{missingFieldsList}} on file at Kerala Association of Nashville (KAN). " +
        "Could you reply to this email with your updated {{missingFieldsList}} so we can keep our membership records current?\n\n" +
        "Thank you!\nKAN Membership Team",
    },
    sms: {
      body:
        "Hi {{name}}, this is KAN — we're missing your {{missingFieldsList}} on file. " +
        "Please reply with your updated {{missingFieldsList}} so we can keep our records current. Thanks!",
    },
  },
};

const TEMPLATES_KEY = "kanReminderTemplates_v1"; // templates themselves are just editing convenience, fine to keep local

function loadTemplates() {
  const raw = localStorage.getItem(TEMPLATES_KEY);
  let templates = null;
  if (raw) {
    try { templates = JSON.parse(raw); } catch (e) { /* ignore */ }
  }
  if (!templates) templates = JSON.parse(JSON.stringify(DEFAULT_TEMPLATES));
  if (!templates.renewal) {
    templates = {
      renewal: { email: templates.email || DEFAULT_TEMPLATES.renewal.email, sms: templates.sms || DEFAULT_TEMPLATES.renewal.sms },
      updateContact: JSON.parse(JSON.stringify(DEFAULT_TEMPLATES.updateContact)),
    };
  }
  if (!templates.updateContact) templates.updateContact = JSON.parse(JSON.stringify(DEFAULT_TEMPLATES.updateContact));
  return templates;
}
function saveTemplates(templates) {
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates));
}
function templatesFor(all, campaign) {
  return campaign === "update-contact" ? all.updateContact : all.renewal;
}

// ---------- Supabase <-> app field mapping ----------

function rowToMember(row, historyByMember) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    category: row.category,
    type: row.type,
    membershipPaymentDate: row.membership_payment_date,
    yearRenewed: row.year_renewed,
    otherNames: row.other_names,
    address: row.address,
    phone: row.phone,
    email: row.email,
    spouseName: row.spouse_name,
    childrenNames: row.children_names,
    nativePlace: row.native_place,
    notes: row.notes,
    attended2026NewYear: row.attended_2026_new_year,
    event2026Payment: row.event_2026_payment,
    event2026MemberStatus: row.event_2026_member_status,
    reminderHistory: (historyByMember && historyByMember[row.id]) || [],
  };
}

function memberToRowPayload(m) {
  return {
    name: m.name,
    status: m.status,
    category: m.category,
    type: m.type,
    membership_payment_date: m.membershipPaymentDate || null,
    year_renewed: m.yearRenewed || null,
    other_names: m.otherNames || null,
    address: m.address || null,
    phone: m.phone || null,
    email: m.email || null,
    spouse_name: m.spouseName || null,
    children_names: m.childrenNames || null,
    native_place: m.nativePlace || null,
    notes: m.notes || null,
    // 2026 event fields are intentionally omitted here (no longer collected
    // in the UI) so inserts/updates never touch or clear that data in the DB.
  };
}

function historyRowToEntry(row) {
  const entry = { date: (row.sent_at || "").slice(0, 10), channel: row.channel };
  if (row.purpose) entry.purpose = row.purpose;
  if (row.reason) entry.reason = row.reason;
  if (row.missing_fields && row.missing_fields.length) entry.missingFields = row.missing_fields;
  return entry;
}

// ---------- data loading ----------

async function loadAllData() {
  const [{ data: memberRows, error: mErr }, { data: historyRows, error: hErr }] = await Promise.all([
    supa.from("members").select("*").order("name"),
    supa.from("reminder_history").select("*").order("sent_at", { ascending: true }),
  ]);

  if (mErr) { console.error(mErr); alert("Could not load members: " + mErr.message); return; }
  if (hErr) { console.error(hErr); alert("Could not load reminder history: " + hErr.message); return; }

  const historyByMember = {};
  (historyRows || []).forEach(row => {
    if (!historyByMember[row.member_id]) historyByMember[row.member_id] = [];
    historyByMember[row.member_id].push(historyRowToEntry(row));
  });

  members = (memberRows || []).map(row => rowToMember(row, historyByMember));
}

// ---------- helpers (same logic as the local app) ----------

function categoryFor(status) {
  if (["Life", "Annual", "Biennial", "Active"].includes(status)) return "Active";
  if (status === "Moved Out") return "Moved Out";
  if (status === "Deleted") return "Deleted";
  if (status === "Expired") return "Renewal Due";
  if (status === "Lapsed") return "Long Lapsed";
  return "Renewal Due";
}
function isDeleted(m) { return m.category === "Deleted"; }

function fmtDate(d) { return d || ""; }
function fmtYear(y) { if (!y) return ""; if (Number(y) <= 1900) return "Unknown"; return String(y); }

function badgeForCategory(cat) {
  const cls = cat === "Active" ? "badge-active" : cat === "Renewal Due" ? "badge-renew" : cat === "Moved Out" ? "badge-moved" : cat === "Deleted" ? "badge-deleted" : "badge-lapsed";
  return `<span class="badge ${cls}">${cat}</span>`;
}
function badgeForStatus(status) {
  let cls = "badge-renew";
  if (status === "Life") cls = "badge-life";
  else if (status === "Annual" || status === "Biennial") cls = "badge-active";
  else if (status === "Lapsed") cls = "badge-lapsed";
  else if (status === "Moved Out") cls = "badge-moved";
  else if (status === "Deleted") cls = "badge-deleted";
  return `<span class="badge ${cls}">${status || "—"}</span>`;
}
function lastReminder(member) {
  const hist = member.reminderHistory || [];
  if (hist.length === 0) return null;
  return hist[hist.length - 1];
}
function reminderDetailLabel(entry) {
  let detail = entry.channel === "sms" ? "text" : "email";
  if (entry.purpose === "update-contact" && entry.missingFields && entry.missingFields.length) {
    detail += " · update: " + entry.missingFields.map(f => CONTACT_FIELD_LABEL[f] || f).join("/");
  } else if (entry.reason) {
    detail += " · " + (REMINDER_REASON_LABEL[entry.reason] || entry.reason);
  }
  return detail;
}
function badgeForReminder(member) {
  const last = lastReminder(member);
  if (!last) return `<span class="badge badge-never">Never</span>`;
  return `<span class="badge badge-reminded">${escapeHtml(`${last.date} (${reminderDetailLabel(last)})`)}</span>`;
}
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length >= 10) return "+" + digits;
  return null;
}
function hasPhone(m) { return !!normalizePhone(m.phone); }
function hasEmail(m) { return !!(m.email && String(m.email).trim()); }
function hasAddress(m) { return !!(m.address && String(m.address).trim()); }
function missingContactFields(m, channel) {
  const checks = channel === "sms" ? ["address", "email"] : ["address", "phone"];
  return checks.filter(f => (f === "address" ? !hasAddress(m) : f === "phone" ? !hasPhone(m) : !hasEmail(m)));
}
function joinFieldList(fields) {
  const labels = fields.map(f => CONTACT_FIELD_LABEL[f] || f);
  if (labels.length === 0) return "contact details";
  if (labels.length === 1) return labels[0];
  return labels.join(" and ");
}
function renderTemplate(str, member, extraVars) {
  const vars = {
    name: member.name || "",
    status: member.status || "",
    category: member.category || "",
    lastPaymentDate: member.membershipPaymentDate || "N/A",
    yearRenewed: member.yearRenewed && Number(member.yearRenewed) > 1900 ? member.yearRenewed : "N/A",
    ...extraVars,
  };
  return String(str || "").replace(/{{\s*(\w+)\s*}}/g, (_, key) => (key in vars ? vars[key] : ""));
}
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------- location chart helpers ----------
// Real member data is messy: "1040 Pittman Dr., Gallatin 37066" (no comma
// before the zip), "117 Brighton lane, Lebanon, TN, 37090" (zip as its own
// segment), "816 Georgebro ct" (street only, no city at all), native places
// like "Idukki (Kerala)" or "Alleppey Kerala" (state glued on with no comma).
// These helpers do their best to pull out just the place name so the chart
// buckets consistently instead of showing raw address fragments.

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
// ---------- place -> region lookups (built from the real member data) ----------
// Keys are lowercase place names as extracted by normalizePlaceKey/extractUsCityName.
// Anything not listed here just doesn't get a home on the map (shown as an
// "outside the map" count instead of guessed at) rather than risk coloring
// the wrong district/county.
const KERALA_DISTRICT_MAP = {
  "trivandrum": "Thiruvananthapuram",
  "thiruvananthapuram": "Thiruvananthapuram",
  "idukki": "Idukki",
  "kozhencherry": "Pathanamthitta",
  "palakkad": "Palakkad",
  "kodungallur": "Thrissur",
  "vayalar": "Alappuzha",
  "kothamangalam": "Ernakulam",
  "ettumanoor": "Kottayam",
  "kuravilangad": "Kottayam",
  "moozhikulangara": "Kottayam",
  "alleppey": "Alappuzha",
  "vazhakulam": "Ernakulam",
  "wayanad": "Wayanad",
  "kannur": "Kannur",
  "kochi": "Ernakulam",
  "kollam": "Kollam",
  "kozhikode": "Kozhikode",
  "calicut": "Kozhikode",
  "thrissur": "Thrissur",
  "trichur": "Thrissur",
  "malappuram": "Malappuram",
  "kottayam": "Kottayam",
  "kasaragod": "Kasaragod",
  "ernakulam": "Ernakulam",
  "pathanamthitta": "Pathanamthitta",
  "alappuzha": "Alappuzha",
};
const TN_COUNTY_MAP = {
  "franklin": "Williamson",
  "fanklin": "Williamson",
  "nashville": "Davidson",
  "nashvill": "Davidson",
  "brentwood": "Williamson",
  "mount juliet": "Wilson",
  "mt juliet": "Wilson",
  "mt. juliet": "Wilson",
  "hermitage": "Davidson",
  "hendersonville": "Sumner",
  "nolensville": "Williamson",
  "clarksville": "Montgomery",
  "gallatin": "Sumner",
  "lebanon": "Wilson",
  "spring hill": "Williamson",
  "springhill": "Williamson",
  "murfreesboro": "Rutherford",
  "madison": "Davidson",
  "thompsons station": "Williamson",
  "cookeville": "Putnam",
  "goodlettsville": "Davidson",
  "old hickory": "Davidson",
  "antioch": "Davidson",
  "smyrna": "Rutherford",
  "la vergne": "Rutherford",
  "dickson": "Dickson",
  "columbia": "Maury",
};

function regionForMember(m, country) {
  const place = country === "india" ? normalizePlaceKey(m.nativePlace) : extractUsCityName(m.address);
  if (!place) return null;
  const map = country === "india" ? KERALA_DISTRICT_MAP : TN_COUNTY_MAP;
  return map[place.toLowerCase()] || null;
}

function buildRegionCounts(country) {
  const counts = new Map(); // region name -> count
  let unmapped = 0;
  members.filter(m => !isDeleted(m)).forEach(m => {
    const region = regionForMember(m, country);
    if (!region) {
      if ((country === "india" ? m.nativePlace : m.address)) unmapped++;
      return;
    }
    counts.set(region, (counts.get(region) || 0) + 1);
  });
  return { counts, unmapped };
}

// ---------- filtering / sorting ----------

function colFilterValue(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : "";
}
function textMatches(fieldValue, query) {
  if (!query) return true;
  if (!fieldValue) return false;
  return String(fieldValue).toLowerCase().includes(query.toLowerCase());
}

function getFiltered() {
  const q = document.getElementById("searchBox").value.trim().toLowerCase();
  const fName = colFilterValue("colf-name");
  const fCategory = colFilterValue("colf-category");
  const fStatus = colFilterValue("colf-status");
  const fType = colFilterValue("colf-type");
  const fPayment = colFilterValue("colf-payment");
  const fYearRenewed = colFilterValue("colf-yearRenewed");
  const fPhone = colFilterValue("colf-phone");
  const fEmail = colFilterValue("colf-email");
  const fAddress = colFilterValue("colf-address");
  const fHousehold = colFilterValue("colf-household");
  const fNotes = colFilterValue("colf-notes");
  const fReminder = colFilterValue("colf-reminder");

  let list = members.filter(m => {
    if (fCategory && m.category !== fCategory) return false;
    if (fStatus && m.status !== fStatus) return false;
    if (fType && m.type !== fType) return false;
    if (mapRegionFilter && regionForMember(m, mapRegionFilter.country) !== mapRegionFilter.region) return false;
    if (fPhone === "has" && !hasPhone(m)) return false;
    if (fPhone === "missing" && hasPhone(m)) return false;
    if (fEmail === "has" && !hasEmail(m)) return false;
    if (fEmail === "missing" && hasEmail(m)) return false;

    const hist = m.reminderHistory || [];
    if (fReminder === "never" && hist.length > 0) return false;
    if (fReminder === "sent" && hist.length === 0) return false;
    if (fReminder === "contact-phone" && !hist.some(h => h.reason === "contact-gap-phone")) return false;
    if (fReminder === "contact-email" && !hist.some(h => h.reason === "contact-gap-email")) return false;
    if (fReminder === "update-address" && !hist.some(h => h.purpose === "update-contact" && (h.missingFields || []).includes("address"))) return false;
    if (fReminder === "update-phone" && !hist.some(h => h.purpose === "update-contact" && (h.missingFields || []).includes("phone"))) return false;
    if (fReminder === "update-email" && !hist.some(h => h.purpose === "update-contact" && (h.missingFields || []).includes("email"))) return false;

    if (!textMatches(m.name, fName)) return false;
    if (!textMatches(m.membershipPaymentDate, fPayment)) return false;
    if (!textMatches(m.yearRenewed, fYearRenewed)) return false;
    if (!textMatches([m.address, m.nativePlace].filter(Boolean).join(" "), fAddress)) return false;
    if (!textMatches([m.spouseName, m.childrenNames].filter(Boolean).join(" "), fHousehold)) return false;
    if (!textMatches(m.notes, fNotes)) return false;

    if (q) {
      const hay = [m.name, m.email, m.phone, m.address, m.nativePlace, m.notes].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  list.sort((a, b) => {
    const f = sortState.field;
    let av = a[f], bv = b[f];
    if (av === null || av === undefined) av = "";
    if (bv === null || bv === undefined) bv = "";
    if (typeof av === "string") av = av.toLowerCase();
    if (typeof bv === "string") bv = bv.toLowerCase();
    if (av < bv) return sortState.dir === "asc" ? -1 : 1;
    if (av > bv) return sortState.dir === "asc" ? 1 : -1;
    return 0;
  });
  return list;
}

// ---------- rendering ----------

function render() {
  const list = getFiltered();
  const tbody = document.getElementById("membersTbody");
  const emptyState = document.getElementById("emptyState");

  if (list.length === 0) {
    tbody.innerHTML = "";
    emptyState.style.display = "block";
  } else {
    emptyState.style.display = "none";
    tbody.innerHTML = list.map(m => `
      <tr data-id="${m.id}" class="${isDeleted(m) ? "row-deleted" : ""}">
        <td><strong>${escapeHtml(m.name)}</strong>${m.otherNames ? `<div style="color:#8a938c;font-size:11px;">${escapeHtml(m.otherNames)}</div>` : ""}</td>
        <td>${badgeForCategory(m.category)}</td>
        <td>${badgeForStatus(m.status)}</td>
        <td>${escapeHtml(m.type || "")}</td>
        <td>${fmtDate(m.membershipPaymentDate)}</td>
        <td>${fmtYear(m.yearRenewed)}</td>
        <td>${escapeHtml(m.phone || "")}</td>
        <td>${escapeHtml(m.email || "")}</td>
        <td>${escapeHtml(m.address || "")}${m.nativePlace ? `<div style="color:#8a938c;font-size:11px;">${escapeHtml(m.nativePlace)}</div>` : ""}</td>
        <td>${[m.spouseName, m.childrenNames].filter(Boolean).map(escapeHtml).join(" · ")}</td>
        <td>${escapeHtml(m.notes || "")}</td>
        <td>${badgeForReminder(m)}</td>
        <td class="row-actions">
          ${isAdmin ? `
            <button class="edit-btn" data-id="${m.id}">Edit</button>
            <button class="danger delete-btn" data-id="${m.id}">Delete</button>
          ` : `<span class="row-actions-locked" title="Only admins can edit or delete members">—</span>`}
        </td>
      </tr>
    `).join("");
  }

  document.getElementById("visibleCount").textContent = `Showing ${list.length} of ${members.length} members`;
  renderStats();
}

function renderStats() {
  // Deleted members are excluded from the overview chart/total and location
  // chart (soft-deleted, no longer "current" membership) but stay visible
  // and filterable in the table itself, per design.
  const total = members.filter(m => !isDeleted(m)).length;
  const categoryCounts = {
    "Active": members.filter(m => m.category === "Active").length,
    "Renewal Due": members.filter(m => m.category === "Renewal Due").length,
    "Long Lapsed": members.filter(m => m.category === "Long Lapsed").length,
    "Moved Out": members.filter(m => m.category === "Moved Out").length,
  };
  document.getElementById("donutTotalValue").textContent = total;
  renderCategoryChart(categoryCounts);
  renderLocationMap();
  renderStatChips();
}

function renderStatChips() {
  const statuses = ["Life", "Annual", "Biennial", "Expired", "Lapsed", "Moved Out", "Deleted"];
  const curStatus = colFilterValue("colf-status");
  document.getElementById("statusChips").innerHTML = statuses.map(status => {
    const count = members.filter(m => m.status === status).length;
    const active = curStatus === status;
    return `<button type="button" class="chip${active ? " active" : ""}" data-chip="status" data-value="${status}">${status} <span class="chip-count">${count}</span></button>`;
  }).join("");

  const noPhone = members.filter(m => !hasPhone(m)).length;
  const noEmail = members.filter(m => !hasEmail(m)).length;
  const missingBoth = members.filter(m => !hasPhone(m) && !hasEmail(m)).length;
  const curPhone = colFilterValue("colf-phone");
  const curEmail = colFilterValue("colf-email");
  const bothActive = curPhone === "missing" && curEmail === "missing";

  document.getElementById("contactChips").innerHTML = `
    <button type="button" class="chip chip-warn${curPhone === "missing" && !bothActive ? " active" : ""}" data-chip="phone-missing">No phone on file <span class="chip-count">${noPhone}</span></button>
    <button type="button" class="chip chip-warn${curEmail === "missing" && !bothActive ? " active" : ""}" data-chip="email-missing">No email on file <span class="chip-count">${noEmail}</span></button>
    <button type="button" class="chip chip-warn${bothActive ? " active" : ""}" data-chip="both-missing">Missing both <span class="chip-count">${missingBoth}</span></button>
  `;

  const curType = colFilterValue("colf-type");
  const familyCount = members.filter(m => m.type === "Family").length;
  const singleCount = members.filter(m => m.type === "Single").length;
  document.getElementById("householdChips").innerHTML = `
    <button type="button" class="chip${curType === "Family" ? " active" : ""}" data-chip="type" data-value="Family">Family <span class="chip-count">${familyCount}</span></button>
    <button type="button" class="chip${curType === "Single" ? " active" : ""}" data-chip="type" data-value="Single">Single <span class="chip-count">${singleCount}</span></button>
  `;
}

// ---------- charts ----------

let categoryChart = null;
let locationChartCountry = "india";
let mapRegionFilter = null; // { country: "india"|"usa", region: "<district or county name>" } | null
let tnCountiesGeo = null;
let keralaDistrictsGeo = null;
let geoDataLoadPromise = null;

const CATEGORY_COLORS = { "Active": "#178a82", "Renewal Due": "#b8860b", "Long Lapsed": "#7a2048", "Moved Out": "#6b3fa0" };

function renderCategoryChart(counts) {
  const canvas = document.getElementById("categoryChartCanvas");
  if (!canvas || typeof Chart === "undefined") return;
  const labels = Object.keys(counts);
  const data = Object.values(counts);
  const bg = labels.map(l => CATEGORY_COLORS[l] || "#999");

  try {
    if (categoryChart) {
      categoryChart.data.labels = labels;
      categoryChart.data.datasets[0].data = data;
      categoryChart.data.datasets[0].backgroundColor = bg;
      categoryChart.update();
      return;
    }

    categoryChart = new Chart(canvas, {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: bg, borderWidth: 2, borderColor: "#fff" }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "68%",
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, padding: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.parsed}` } },
      },
      onHover: (evt, elements) => { evt.native.target.style.cursor = elements.length ? "pointer" : "default"; },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const idx = elements[0].index;
        const label = categoryChart.data.labels[idx];
        const el = document.getElementById("colf-category");
        el.value = el.value === label ? "" : label;
        render();
        const wrap = document.querySelector(".table-wrap");
        if (wrap) wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
      },
      },
    });
  } catch (e) {
    console.error("Could not render category chart:", e);
  }
}

async function loadGeoData() {
  if (geoDataLoadPromise) return geoDataLoadPromise;
  geoDataLoadPromise = Promise.all([
    fetch("data/kerala_districts.geojson").then(r => r.json()).catch(() => null),
    fetch("data/tn_counties.geojson").then(r => r.json()).catch(() => null),
  ]).then(([kerala, tn]) => { keralaDistrictsGeo = kerala; tnCountiesGeo = tn; });
  return geoDataLoadPromise;
}

function regionDisplayName(feature, country) {
  return country === "india" ? feature.properties.DISTRICT : feature.properties.name;
}

function updateMapRegionFilterChip() {
  const chip = document.getElementById("mapRegionFilterChip");
  if (!chip) return;
  if (!mapRegionFilter) { chip.style.display = "none"; chip.textContent = ""; return; }
  const label = mapRegionFilter.country === "india" ? `${mapRegionFilter.region} district` : `${mapRegionFilter.region} County`;
  chip.style.display = "inline-flex";
  chip.textContent = `Map filter: ${label} ✕`;
}

async function renderLocationMap() {
  const container = document.getElementById("locationMapContainer");
  const noteEl = document.getElementById("locationMapNote");
  if (!container || typeof d3 === "undefined") return;
  updateMapRegionFilterChip();

  try {
    await loadGeoData();
    const geo = locationChartCountry === "india" ? keralaDistrictsGeo : tnCountiesGeo;
    if (!geo || !geo.features) {
      container.innerHTML = "";
      if (noteEl) noteEl.textContent = "Map data couldn't be loaded.";
      return;
    }

    const { counts, unmapped } = buildRegionCounts(locationChartCountry);
    const max = Math.max(1, ...Array.from(counts.values()));
    const color = locationChartCountry === "india"
      ? d3.scaleSequential(d3.interpolateOranges).domain([0, max])
      : d3.scaleSequential(d3.interpolateBlues).domain([0, max]);

    container.innerHTML = "";
    const width = container.clientWidth || 380;
    const height = 230;
    const svg = d3.select(container).append("svg")
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("width", "100%")
      .attr("height", height)
      .attr("role", "img")
      .attr("aria-label", locationChartCountry === "india" ? "Map of Kerala districts by member count" : "Map of Tennessee counties by member count");

    const projection = d3.geoMercator().fitSize([width, height], geo);
    const path = d3.geoPath(projection);
    const tooltip = document.getElementById("locationMapTooltip");
    const activeRegion = mapRegionFilter && mapRegionFilter.country === locationChartCountry ? mapRegionFilter.region : null;

    svg.selectAll("path")
      .data(geo.features)
      .join("path")
      .attr("d", path)
      .attr("fill", d => {
        const count = counts.get(regionDisplayName(d, locationChartCountry)) || 0;
        return count > 0 ? color(count) : "#eef0f6";
      })
      .attr("stroke", d => (regionDisplayName(d, locationChartCountry) === activeRegion ? "#1b2a55" : "#fff"))
      .attr("stroke-width", d => (regionDisplayName(d, locationChartCountry) === activeRegion ? 2 : 0.75))
      .style("cursor", "pointer")
      .on("mousemove", (event, d) => {
        if (!tooltip) return;
        const name = regionDisplayName(d, locationChartCountry);
        const count = counts.get(name) || 0;
        tooltip.style.display = "block";
        tooltip.textContent = `${name}: ${count} member${count === 1 ? "" : "s"}`;
        const rect = container.getBoundingClientRect();
        tooltip.style.left = (event.clientX - rect.left + 12) + "px";
        tooltip.style.top = (event.clientY - rect.top + 12) + "px";
      })
      .on("mouseleave", () => { if (tooltip) tooltip.style.display = "none"; })
      .on("click", (event, d) => {
        const name = regionDisplayName(d, locationChartCountry);
        if (mapRegionFilter && mapRegionFilter.country === locationChartCountry && mapRegionFilter.region === name) {
          mapRegionFilter = null;
        } else {
          mapRegionFilter = { country: locationChartCountry, region: name };
        }
        render();
        renderLocationMap();
        const wrap = document.querySelector(".table-wrap");
        if (wrap) wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });

    renderLocationMapLegend(max, color);

    if (noteEl) {
      noteEl.textContent = unmapped > 0
        ? `Click a region to filter the table below. ${unmapped} member${unmapped === 1 ? "" : "s"} outside this map's area aren't shown here.`
        : "Click a region to filter the table below by that place.";
    }
  } catch (e) {
    console.error("Could not render location map:", e);
  }
}

function renderLocationMapLegend(max, color) {
  const legend = document.getElementById("locationMapLegend");
  if (!legend) return;
  const steps = 5;
  let swatches = "";
  for (let i = 0; i <= steps; i++) {
    const v = Math.round((max / steps) * i);
    swatches += `<span class="map-legend-swatch" style="background:${v > 0 ? color(v) : "#eef0f6"}"></span>`;
  }
  legend.innerHTML = `<div class="map-legend-scale">${swatches}</div><div class="map-legend-labels"><span>0</span><span>${max} members</span></div>`;
}

// ---------- modal / CRUD ----------

function openModal(member) {
  if (!isAdmin) { alert(member ? "Only admins can edit members." : "Only admins can add members."); return; }
  editingId = member ? member.id : null;
  document.getElementById("modalTitle").textContent = member ? "Edit Member" : "Add Member";
  document.getElementById("btnDeleteMember").style.display = (member && isAdmin) ? "inline-block" : "none";
  document.getElementById("fieldId").value = member ? member.id : "";
  document.getElementById("fieldName").value = member ? member.name || "" : "";
  document.getElementById("fieldStatus").value = member ? member.status || "Annual" : "Annual";
  document.getElementById("fieldType").value = member ? member.type || "Family" : "Family";
  document.getElementById("fieldPaymentDate").value = member ? member.membershipPaymentDate || "" : "";
  document.getElementById("fieldYearRenewed").value = member && member.yearRenewed ? member.yearRenewed : "";
  document.getElementById("fieldPhone").value = member ? member.phone || "" : "";
  document.getElementById("fieldEmail").value = member ? member.email || "" : "";
  document.getElementById("fieldAddress").value = member ? member.address || "" : "";
  document.getElementById("fieldNativePlace").value = member ? member.nativePlace || "" : "";
  document.getElementById("fieldSpouseName").value = member ? member.spouseName || "" : "";
  document.getElementById("fieldChildrenNames").value = member ? member.childrenNames || "" : "";
  document.getElementById("fieldNotes").value = member ? member.notes || "" : "";
  document.getElementById("memberModal").style.display = "flex";
}
function closeModal() {
  document.getElementById("memberModal").style.display = "none";
  editingId = null;
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const status = document.getElementById("fieldStatus").value;
  const data = {
    name: document.getElementById("fieldName").value.trim(),
    status,
    category: categoryFor(status),
    type: document.getElementById("fieldType").value,
    membershipPaymentDate: document.getElementById("fieldPaymentDate").value || null,
    yearRenewed: document.getElementById("fieldYearRenewed").value ? Number(document.getElementById("fieldYearRenewed").value) : null,
    phone: document.getElementById("fieldPhone").value.trim() || null,
    email: document.getElementById("fieldEmail").value.trim() || null,
    address: document.getElementById("fieldAddress").value.trim() || null,
    nativePlace: document.getElementById("fieldNativePlace").value.trim() || null,
    spouseName: document.getElementById("fieldSpouseName").value.trim() || null,
    childrenNames: document.getElementById("fieldChildrenNames").value.trim() || null,
    notes: document.getElementById("fieldNotes").value.trim() || null,
  };
  if (!data.name) return;

  if (editingId) {
    if (!isAdmin) { alert("Only admins can edit members."); return; }
    const { error } = await supa.from("members").update(memberToRowPayload(data)).eq("id", editingId);
    if (error) { alert("Could not save: " + error.message); return; }
  } else {
    if (!isAdmin) { alert("Only admins can add members."); return; }
    const { error } = await supa.from("members").insert(memberToRowPayload(data));
    if (error) { alert("Could not save: " + error.message); return; }
  }

  await loadAllData();
  closeModal();
  render();
}

async function deleteMember(id) {
  if (!isAdmin) { alert("Only admins can delete members."); return; }
  const m = members.find(x => x.id === id);
  if (!m) return;
  if (isDeleted(m)) { alert(`"${m.name}" is already marked Deleted.`); return; }
  if (!confirm(`Mark "${m.name}" as Deleted?\n\nTheir record and reminder history are kept, not erased — they'll show a Deleted badge, drop out of renewal reminders and reports, and stay filterable. To undo, open Edit and change their Status.`)) return;
  const { error } = await supa.from("members").update({ status: "Deleted", category: "Deleted" }).eq("id", id);
  if (error) { alert("Could not mark as deleted: " + error.message); return; }
  await loadAllData();
  render();
}

// ---------- Excel export ----------

function memberToRow(m) {
  const last = lastReminder(m);
  return {
    "Name": m.name, "Category": m.category, "Status": m.status, "Household Type": m.type,
    "Last Payment Date": m.membershipPaymentDate || "",
    "Year Renewed": m.yearRenewed && Number(m.yearRenewed) > 1900 ? m.yearRenewed : "",
    "Phone": m.phone || "", "Email": m.email || "", "Address": m.address || "", "Native Place": m.nativePlace || "",
    "Spouse Name": m.spouseName || "", "Children's Names": m.childrenNames || "", "Notes": m.notes || "",
    "Last Reminder Sent": last ? `${last.date} (${reminderDetailLabel(last)})` : "Never",
  };
}
function downloadWorkbook(sheets, filename) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name, rows }) => {
    const ws = XLSX.utils.json_to_sheet(rows.map(memberToRow));
    XLSX.utils.book_append_sheet(wb, ws, name.substring(0, 31));
  });
  XLSX.writeFile(wb, filename);
}
function downloadFilteredView() {
  const list = getFiltered();
  if (list.length === 0) { alert("No rows match the current filters."); return; }
  downloadWorkbook([{ name: "Filtered Members", rows: list }], `KAN_Members_Filtered_${dateStamp()}.xlsx`);
}
function downloadNotRenewed() {
  const list = members.filter(m => m.category !== "Active" && !isDeleted(m));
  downloadWorkbook([{ name: "Not Renewed", rows: list }], `KAN_Members_Not_Renewed_${dateStamp()}.xlsx`);
}
function downloadFullReport() {
  const sheets = [
    { name: "Active Members", rows: members.filter(m => m.category === "Active") },
    { name: "Members To Renew", rows: members.filter(m => m.category === "Renewal Due") },
    { name: "Not Renewed - Long Term", rows: members.filter(m => m.category === "Long Lapsed") },
  ];
  const deleted = members.filter(m => isDeleted(m));
  if (deleted.length) sheets.push({ name: "Deleted", rows: deleted });
  downloadWorkbook(sheets, `KAN_Membership_Full_Report_${dateStamp()}.xlsx`);
}
function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function exportJson() {
  const blob = new Blob([JSON.stringify(members, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `KAN_Members_${dateStamp()}.json`; a.click();
  URL.revokeObjectURL(url);
}

// ---------- reminders ----------

function currentReminderChannel() {
  const checked = document.querySelector('input[name="reminderChannel"]:checked');
  return checked ? checked.value : "email";
}

function setReminderComposeFields(channel, campaign) {
  const templates = loadTemplates();
  const t = templatesFor(templates, campaign);
  document.getElementById("reminderSubject").value = t.email.subject;
  document.getElementById("reminderBody").value = channel === "sms" ? t.sms.body : t.email.body;
  document.getElementById("reminderSubjectWrap").style.display = channel === "sms" ? "none" : "flex";
}

function openReminderModal() {
  reminderChannel = currentReminderChannel();
  reminderReason = null;
  reminderCampaign = "renewal";
  setReminderComposeFields(reminderChannel, reminderCampaign);
  document.getElementById("reminderStepSelect").style.display = "block";
  document.getElementById("reminderStepQueue").style.display = "none";
  const preselect = new Set(getFiltered().filter(m => m.category !== "Active" && !isDeleted(m)).map(m => m.id));
  renderRecipientList(preselect);
  document.getElementById("reminderModal").style.display = "flex";
}
function closeReminderModal() {
  document.getElementById("reminderModal").style.display = "none";
}

function renderRecipientList(preselectIds) {
  const channel = currentReminderChannel();
  const container = document.getElementById("reminderRecipientList");
  const sorted = members.filter(m => !isDeleted(m)).sort((a, b) => a.name.localeCompare(b.name));
  container.innerHTML = sorted.map(m => {
    const contact = channel === "sms" ? normalizePhone(m.phone) : (m.email || null);
    const missing = !contact;
    const checked = !missing && (preselectIds ? preselectIds.has(m.id) : false);
    return `
      <label class="reminder-recipient-row ${missing ? "no-contact" : ""}">
        <input type="checkbox" class="reminder-check" data-id="${m.id}" ${checked ? "checked" : ""} ${missing ? "disabled" : ""} />
        <span class="r-name">${escapeHtml(m.name)}</span>
        ${badgeForCategory(m.category)}
        <span class="r-contact">${missing ? `<span class="r-missing">No ${channel === "sms" ? "phone" : "email"} on file</span>` : escapeHtml(contact)}</span>
      </label>
    `;
  }).join("");
  updateSelectedCount();
}
function updateSelectedCount() {
  const n = document.querySelectorAll(".reminder-check:checked").length;
  document.getElementById("reminderSelectedCount").textContent = `${n} selected`;
}
function getSelectedReminderMembers() {
  const ids = Array.from(document.querySelectorAll(".reminder-check:checked")).map(cb => Number(cb.dataset.id));
  const idSet = new Set(ids);
  return members.filter(m => idSet.has(m.id));
}
function selectRecipientsByPredicate(predicate) {
  reminderReason = null;
  if (reminderCampaign !== "renewal") {
    reminderCampaign = "renewal";
    setReminderComposeFields(currentReminderChannel(), "renewal");
  }
  document.querySelectorAll(".reminder-check").forEach(cb => {
    const m = members.find(x => x.id === Number(cb.dataset.id));
    if (!cb.disabled) cb.checked = m ? predicate(m) : false;
  });
  updateSelectedCount();
}
function selectContactGapRecipients(reason) {
  reminderReason = reason;
  reminderCampaign = "renewal";
  const channel = reason === "contact-gap-phone" ? "email" : "sms";
  reminderChannel = channel;
  const radio = document.querySelector(`input[name="reminderChannel"][value="${channel}"]`);
  if (radio) radio.checked = true;
  setReminderComposeFields(channel, "renewal");
  const preselect = new Set(members.filter(m => (reason === "contact-gap-phone" ? (!hasPhone(m) && hasEmail(m)) : (!hasEmail(m) && hasPhone(m)))).map(m => m.id));
  renderRecipientList(preselect);
}
function selectUpdateContactRecipients(channel) {
  reminderReason = null;
  reminderCampaign = "update-contact";
  reminderChannel = channel;
  const radio = document.querySelector(`input[name="reminderChannel"][value="${channel}"]`);
  if (radio) radio.checked = true;
  setReminderComposeFields(channel, "update-contact");
  const preselect = new Set(members.filter(m => missingContactFields(m, channel).length > 0 && (channel === "sms" ? hasPhone(m) : hasEmail(m))).map(m => m.id));
  renderRecipientList(preselect);
}
function buildLogOptions(member, channel) {
  if (reminderCampaign === "update-contact") return { purpose: "update-contact", missingFields: missingContactFields(member, channel) };
  if (reminderReason) return { reason: reminderReason };
  return null;
}

async function logReminder(memberId, channel, options) {
  const payload = {
    member_id: memberId,
    channel,
    sent_by: currentUser ? currentUser.email : null,
  };
  if (options && options.reason) payload.reason = options.reason;
  if (options && options.purpose) payload.purpose = options.purpose;
  if (options && options.missingFields && options.missingFields.length) payload.missing_fields = options.missingFields;
  const { error } = await supa.from("reminder_history").insert(payload);
  if (error) console.error("Could not log reminder:", error);
}

function normalizePhoneOrNull(phone) { return normalizePhone(phone); }

function buildSmsUrl(phone, body) {
  const params = new URLSearchParams();
  // encodeURIComponent (not URLSearchParams.toString) so spaces become %20, not +
  const q = body ? `body=${encodeURIComponent(body)}` : "";
  return `sms:${phone}${q ? "?" + q : ""}`;
}
function openExternalLink(url) {
  const a = document.createElement("a");
  a.href = url; a.style.display = "none";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

async function startQueue() {
  const channel = currentReminderChannel();
  reminderChannel = channel;
  const selected = getSelectedReminderMembers().filter(m => channel === "sms" ? normalizePhone(m.phone) : m.email);
  if (selected.length === 0) {
    alert(`None of the selected members have a usable ${channel === "sms" ? "phone number" : "email address"}.`);
    return;
  }
  const templates = loadTemplates();
  const t = templatesFor(templates, reminderCampaign);
  if (channel === "email") { t.email.subject = document.getElementById("reminderSubject").value; t.email.body = document.getElementById("reminderBody").value; }
  else { t.sms.body = document.getElementById("reminderBody").value; }
  saveTemplates(templates);

  reminderQueue = selected;
  reminderQueueIndex = 0;
  document.getElementById("reminderStepSelect").style.display = "none";
  document.getElementById("reminderStepQueue").style.display = "block";
  document.getElementById("queueSubjectWrap").style.display = channel === "sms" ? "none" : "flex";
  document.getElementById("btnSendCurrent").textContent = channel === "sms" ? "Open in Messages" : "Send & Next →";
  renderQueueStep();
}

function renderQueueStep() {
  const templates = loadTemplates();
  const t = templatesFor(templates, reminderCampaign);
  const m = reminderQueue[reminderQueueIndex];
  const total = reminderQueue.length;

  document.getElementById("queueProgressText").textContent = `${reminderQueueIndex + 1} of ${total}`;
  document.getElementById("queueProgressFill").style.width = `${(reminderQueueIndex / total) * 100}%`;
  document.getElementById("queueRecipientName").textContent = m.name;
  document.getElementById("queueSendStatus").textContent = "";

  const contact = reminderChannel === "sms" ? normalizePhone(m.phone) : m.email;
  document.getElementById("queueRecipientContact").textContent =
    `${reminderChannel === "sms" ? "Text" : "Email"} to: ${contact} — Category: ${m.category}, Status: ${m.status}`;

  const extraVars = {};
  if (reminderCampaign === "update-contact") extraVars.missingFieldsList = joinFieldList(missingContactFields(m, reminderChannel));

  document.getElementById("queueSubjectField").value = reminderChannel === "sms" ? "" : renderTemplate(t.email.subject, m, extraVars);
  document.getElementById("queueBodyField").value = renderTemplate(reminderChannel === "sms" ? t.sms.body : t.email.body, m, extraVars);
}

async function sendCurrentQueueItem() {
  const m = reminderQueue[reminderQueueIndex];
  const subject = document.getElementById("queueSubjectField").value;
  const body = document.getElementById("queueBodyField").value;
  const statusEl = document.getElementById("queueSendStatus");

  if (reminderChannel === "sms") {
    const phone = normalizePhone(m.phone);
    openExternalLink(buildSmsUrl(phone, body));
    await logReminder(m.id, "sms", buildLogOptions(m, "sms"));
    advanceQueue();
    return;
  }

  // email: actually send it now, through the Edge Function
  statusEl.textContent = "Sending…";
  const sendBtn = document.getElementById("btnSendCurrent");
  sendBtn.disabled = true;
  try {
    const { data: sessionData } = await supa.auth.getSession();
    const resp = await fetch(`${window.KAN_CONFIG.SUPABASE_URL}/functions/v1/send-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${sessionData.session.access_token}`,
        "apikey": window.KAN_CONFIG.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ to: m.email, subject, body }),
    });
    const result = await resp.json();
    if (!resp.ok || result.error) {
      statusEl.textContent = "Failed to send: " + (result.error || "unknown error");
      sendBtn.disabled = false;
      return;
    }
    await logReminder(m.id, "email", buildLogOptions(m, "email"));
    advanceQueue();
  } catch (e) {
    statusEl.textContent = "Failed to send: " + e.message;
  } finally {
    sendBtn.disabled = false;
  }
}

function advanceQueue() {
  reminderQueueIndex++;
  if (reminderQueueIndex >= reminderQueue.length) {
    document.getElementById("queueProgressFill").style.width = "100%";
    loadAllData().then(render);
    alert(`Done. Reminder queue finished (${reminderQueue.length} member${reminderQueue.length === 1 ? "" : "s"}).`);
    reminderReason = null;
    reminderCampaign = "renewal";
    closeReminderModal();
    return;
  }
  renderQueueStep();
}

// ---------- Manage Access ----------

async function openAccessModal() {
  const { data, error } = await supa.from("allowed_users").select("*").order("added_at");
  if (error) { alert("Could not load access list: " + error.message); return; }
  renderAccessList(data || []);
  document.getElementById("accessModal").style.display = "flex";
}
function closeAccessModal() {
  document.getElementById("accessModal").style.display = "none";
}
function renderAccessList(rows) {
  document.getElementById("accessUserList").innerHTML = rows.map(r => `
    <div class="access-user-row">
      <div class="au-info">
        <span class="au-name">${escapeHtml(r.name || r.email)}${r.is_admin ? ` <span class="au-admin-badge">Admin</span>` : ""}</span>
        <span class="au-meta">${escapeHtml(r.position || "")}${r.position ? " · " : ""}${escapeHtml(r.email)}</span>
      </div>
      <button type="button" class="remove-access-btn" data-email="${escapeHtml(r.email)}">Remove</button>
    </div>
  `).join("");
}
async function addAccessUser(name, email, position, admin) {
  const { error } = await supa.from("allowed_users").insert({
    email: email.trim().toLowerCase(),
    name: name.trim() || null,
    position: position.trim() || null,
    is_admin: admin,
    added_by: currentUser.email,
  });
  if (error) { alert("Could not add: " + error.message); return; }
  openAccessModal();
}
async function removeAccessUser(email) {
  if (!confirm(`Remove access for ${email}?`)) return;
  const { error } = await supa.from("allowed_users").delete().eq("email", email);
  if (error) { alert("Could not remove: " + error.message); return; }
  openAccessModal();
}

// ---------- auth ----------

async function checkAccess(email) {
  const { data, error } = await supa.from("allowed_users").select("*").eq("email", email).maybeSingle();
  if (error) { console.error(error); return null; }
  return data;
}

async function handleAuthedSession(session) {
  currentUser = { email: session.user.email };
  const access = await checkAccess(currentUser.email);
  if (!access) {
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("appRoot").style.display = "none";
    document.getElementById("noAccessScreen").style.display = "flex";
    document.getElementById("noAccessEmail").textContent = currentUser.email;
    return;
  }
  isAdmin = !!access.is_admin;
  currentUser.name = access.name || null;
  currentUser.position = access.position || null;
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("noAccessScreen").style.display = "none";
  document.getElementById("appRoot").style.display = "block";
  document.getElementById("whoamiLabel").textContent = currentUser.name
    ? currentUser.name + (currentUser.position ? " — " + currentUser.position : "")
    : currentUser.email; // fall back to email only until this person's profile is filled in from Manage Access
  document.getElementById("btnManageAccess").style.display = isAdmin ? "inline-block" : "none";
  document.getElementById("btnAddMember").style.display = isAdmin ? "inline-block" : "none";

  await loadAllData();
  render();
}

async function initAuth() {
  supa = window.supabase.createClient(window.KAN_CONFIG.SUPABASE_URL, window.KAN_CONFIG.SUPABASE_ANON_KEY);

  const { data: { session } } = await supa.auth.getSession();
  if (session) {
    await handleAuthedSession(session);
  }

  supa.auth.onAuthStateChange(async (_event, session) => {
    if (session) {
      await handleAuthedSession(session);
    } else {
      currentUser = null;
      document.getElementById("appRoot").style.display = "none";
      document.getElementById("noAccessScreen").style.display = "none";
      document.getElementById("loginScreen").style.display = "flex";
    }
  });
}

// ---------- wiring ----------

function attachEvents() {
  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("loginEmail").value.trim();
    const statusEl = document.getElementById("loginStatus");
    const submitBtn = document.querySelector("#loginForm button[type=submit]");
    statusEl.className = "auth-status";
    statusEl.textContent = "Sending your login link…";
    submitBtn.disabled = true;
    const { error } = await supa.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
    submitBtn.disabled = false;
    if (error) {
      statusEl.className = "auth-status auth-status-error";
      statusEl.textContent = "Couldn't send the link: " + error.message;
    } else {
      statusEl.className = "auth-status auth-status-ok";
      statusEl.textContent = `Check ${email} for your login link. It may take a minute to arrive — check spam too.`;
    }
  });

  document.getElementById("btnSignOut").addEventListener("click", () => supa.auth.signOut());
  document.getElementById("btnSignOutNoAccess").addEventListener("click", () => supa.auth.signOut());

  document.getElementById("btnAddMember").addEventListener("click", () => openModal(null));
  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("btnCancelModal").addEventListener("click", closeModal);
  document.getElementById("memberModal").addEventListener("click", (e) => { if (e.target.id === "memberModal") closeModal(); });
  document.getElementById("memberForm").addEventListener("submit", handleFormSubmit);
  document.getElementById("btnDeleteMember").addEventListener("click", () => { if (editingId) { const id = editingId; closeModal(); deleteMember(id); } });

  document.getElementById("membersTbody").addEventListener("click", (e) => {
    const id = Number(e.target.dataset.id);
    if (!id) return;
    if (e.target.classList.contains("edit-btn")) { const m = members.find(x => x.id === id); if (m) openModal(m); }
    else if (e.target.classList.contains("delete-btn")) deleteMember(id);
  });

  const columnFilterIds = ["colf-name", "colf-category", "colf-status", "colf-type", "colf-payment", "colf-yearRenewed", "colf-phone", "colf-email", "colf-address", "colf-household", "colf-notes", "colf-reminder"];
  ["searchBox", ...columnFilterIds].forEach(id => {
    document.getElementById(id).addEventListener("input", render);
    document.getElementById(id).addEventListener("change", render);
  });
  document.getElementById("btnClearFilters").addEventListener("click", () => {
    document.getElementById("searchBox").value = "";
    columnFilterIds.forEach(id => { document.getElementById(id).value = ""; });
    mapRegionFilter = null;
    render();
    renderLocationMap();
  });
  document.getElementById("mapRegionFilterChip").addEventListener("click", () => {
    mapRegionFilter = null;
    render();
    renderLocationMap();
  });

  document.getElementById("statusChips").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip"); if (!btn) return;
    const el = document.getElementById("colf-status");
    el.value = el.value === btn.dataset.value ? "" : btn.dataset.value;
    render();
  });
  document.getElementById("contactChips").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip"); if (!btn) return;
    const phoneEl = document.getElementById("colf-phone");
    const emailEl = document.getElementById("colf-email");
    const chip = btn.dataset.chip;
    if (chip === "phone-missing") { const on = !(phoneEl.value === "missing" && emailEl.value !== "missing"); phoneEl.value = on ? "missing" : ""; emailEl.value = ""; }
    else if (chip === "email-missing") { const on = !(emailEl.value === "missing" && phoneEl.value !== "missing"); emailEl.value = on ? "missing" : ""; phoneEl.value = ""; }
    else if (chip === "both-missing") { const on = !(phoneEl.value === "missing" && emailEl.value === "missing"); phoneEl.value = on ? "missing" : ""; emailEl.value = on ? "missing" : ""; }
    render();
  });
  document.getElementById("householdChips").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip"); if (!btn) return;
    const el = document.getElementById("colf-type");
    el.value = el.value === btn.dataset.value ? "" : btn.dataset.value;
    render();
  });
  document.getElementById("locationToggle").addEventListener("click", (e) => {
    const btn = e.target.closest(".loc-toggle-btn"); if (!btn) return;
    document.querySelectorAll(".loc-toggle-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    locationChartCountry = btn.dataset.country;
    renderLocationMap();
  });

  document.querySelectorAll("thead th[data-sort]").forEach(th => {
    th.addEventListener("click", () => {
      const field = th.dataset.sort;
      if (sortState.field === field) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      else { sortState.field = field; sortState.dir = "asc"; }
      render();
    });
  });

  document.getElementById("btnDownloadFiltered").addEventListener("click", downloadFilteredView);
  document.getElementById("btnDownloadNotRenewed").addEventListener("click", downloadNotRenewed);
  document.getElementById("btnDownloadFull").addEventListener("click", downloadFullReport);
  document.getElementById("btnExportJson").addEventListener("click", exportJson);

  document.getElementById("btnSendReminders").addEventListener("click", openReminderModal);
  document.getElementById("reminderModalClose").addEventListener("click", closeReminderModal);
  document.getElementById("reminderModal").addEventListener("click", (e) => { if (e.target.id === "reminderModal") closeReminderModal(); });

  document.querySelectorAll('input[name="reminderChannel"]').forEach(radio => {
    radio.addEventListener("change", () => {
      reminderReason = null;
      reminderCampaign = "renewal";
      const channel = currentReminderChannel();
      setReminderComposeFields(channel, "renewal");
      const currentlySelected = new Set(getSelectedReminderMembers().map(m => m.id));
      renderRecipientList(currentlySelected);
    });
  });
  document.getElementById("reminderRecipientList").addEventListener("change", (e) => { if (e.target.classList.contains("reminder-check")) updateSelectedCount(); });

  document.getElementById("btnSelectRenewalDue").addEventListener("click", () => selectRecipientsByPredicate(m => m.category === "Renewal Due"));
  document.getElementById("btnSelectLongLapsed").addEventListener("click", () => selectRecipientsByPredicate(m => m.category === "Long Lapsed"));
  document.getElementById("btnSelectNotActive").addEventListener("click", () => selectRecipientsByPredicate(m => m.category !== "Active" && !isDeleted(m)));
  document.getElementById("btnSelectNone").addEventListener("click", () => selectRecipientsByPredicate(() => false));
  document.getElementById("btnSelectMissingPhone").addEventListener("click", () => selectContactGapRecipients("contact-gap-phone"));
  document.getElementById("btnSelectMissingEmail").addEventListener("click", () => selectContactGapRecipients("contact-gap-email"));
  document.getElementById("btnSelectUpdateContactEmail").addEventListener("click", () => selectUpdateContactRecipients("email"));
  document.getElementById("btnSelectUpdateContactSms").addEventListener("click", () => selectUpdateContactRecipients("sms"));

  document.getElementById("btnStartQueue").addEventListener("click", startQueue);
  document.getElementById("btnCloseQueue").addEventListener("click", closeReminderModal);
  document.getElementById("btnSkipQueue").addEventListener("click", advanceQueue);
  document.getElementById("btnSendCurrent").addEventListener("click", sendCurrentQueueItem);

  document.getElementById("btnManageAccess").addEventListener("click", openAccessModal);
  document.getElementById("accessModalClose").addEventListener("click", closeAccessModal);
  document.getElementById("accessModal").addEventListener("click", (e) => { if (e.target.id === "accessModal") closeAccessModal(); });
  document.getElementById("addAccessForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("newAccessName").value;
    const email = document.getElementById("newAccessEmail").value;
    const position = document.getElementById("newAccessPosition").value;
    const admin = document.getElementById("newAccessIsAdmin").checked;
    addAccessUser(name, email, position, admin);
    document.getElementById("newAccessName").value = "";
    document.getElementById("newAccessEmail").value = "";
    document.getElementById("newAccessPosition").value = "";
    document.getElementById("newAccessIsAdmin").checked = false;
  });
  document.getElementById("accessUserList").addEventListener("click", (e) => {
    if (e.target.classList.contains("remove-access-btn")) removeAccessUser(e.target.dataset.email);
  });
}

// ---------- init ----------

async function init() {
  attachEvents();
  await initAuth();
}

document.addEventListener("DOMContentLoaded", init);
