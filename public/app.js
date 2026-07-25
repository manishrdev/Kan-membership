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
    attended_2026_new_year: !!m.attended2026NewYear,
    event_2026_payment: m.event2026Payment || null,
    event_2026_member_status: m.event2026MemberStatus || null,
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
  if (status === "Expired") return "Renewal Due";
  if (status === "Lapsed") return "Long Lapsed";
  return "Renewal Due";
}

function fmtDate(d) { return d || ""; }
function fmtYear(y) { if (!y) return ""; if (Number(y) <= 1900) return "Unknown"; return String(y); }

function badgeForCategory(cat) {
  const cls = cat === "Active" ? "badge-active" : cat === "Renewal Due" ? "badge-renew" : "badge-lapsed";
  return `<span class="badge ${cls}">${cat}</span>`;
}
function badgeForStatus(status) {
  let cls = "badge-renew";
  if (status === "Life") cls = "badge-life";
  else if (status === "Annual" || status === "Biennial") cls = "badge-active";
  else if (status === "Lapsed") cls = "badge-lapsed";
  return `<span class="badge ${cls}">${status || "—"}</span>`;
}
function badgeForEvent(attended) {
  return attended ? `<span class="badge badge-yes">Attended</span>` : `<span class="badge badge-no">No</span>`;
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
  const fEvent = colFilterValue("colf-event");
  const fReminder = colFilterValue("colf-reminder");

  let list = members.filter(m => {
    if (fCategory && m.category !== fCategory) return false;
    if (fStatus && m.status !== fStatus) return false;
    if (fType && m.type !== fType) return false;
    if (fEvent === "yes" && !m.attended2026NewYear) return false;
    if (fEvent === "no" && m.attended2026NewYear) return false;
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
      <tr data-id="${m.id}">
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
        <td>${badgeForEvent(m.attended2026NewYear)}${m.event2026Payment ? `<div style="font-size:11px;color:#8a938c;">$${m.event2026Payment}</div>` : ""}</td>
        <td>${badgeForReminder(m)}</td>
        <td class="row-actions">
          <button class="edit-btn" data-id="${m.id}">Edit</button>
          <button class="danger delete-btn" data-id="${m.id}">Delete</button>
        </td>
      </tr>
    `).join("");
  }

  document.getElementById("visibleCount").textContent = `Showing ${list.length} of ${members.length} members`;
  renderStats();
}

function renderStats() {
  const total = members.length;
  document.getElementById("statTotal").textContent = total;
  document.getElementById("statActive").textContent = members.filter(m => m.category === "Active").length;
  document.getElementById("statRenew").textContent = members.filter(m => m.category === "Renewal Due").length;
  document.getElementById("statLapsed").textContent = members.filter(m => m.category === "Long Lapsed").length;
  renderStatChips();
}

function renderStatChips() {
  const statuses = ["Life", "Annual", "Biennial", "Expired", "Lapsed"];
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
}

// ---------- modal / CRUD ----------

function openModal(member) {
  editingId = member ? member.id : null;
  document.getElementById("modalTitle").textContent = member ? "Edit Member" : "Add Member";
  document.getElementById("btnDeleteMember").style.display = member ? "inline-block" : "none";
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
  document.getElementById("fieldAttended2026").value = member && member.attended2026NewYear ? "true" : "false";
  document.getElementById("fieldEventPayment").value = member && member.event2026Payment ? member.event2026Payment : "";
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
    attended2026NewYear: document.getElementById("fieldAttended2026").value === "true",
    event2026Payment: document.getElementById("fieldEventPayment").value ? Number(document.getElementById("fieldEventPayment").value) : null,
  };
  if (!data.name) return;

  if (editingId) {
    const { error } = await supa.from("members").update(memberToRowPayload(data)).eq("id", editingId);
    if (error) { alert("Could not save: " + error.message); return; }
  } else {
    const { error } = await supa.from("members").insert(memberToRowPayload(data));
    if (error) { alert("Could not save: " + error.message); return; }
  }

  await loadAllData();
  closeModal();
  render();
}

async function deleteMember(id) {
  const m = members.find(x => x.id === id);
  if (!m) return;
  if (!confirm(`Delete "${m.name}" from the tracker? This cannot be undone.`)) return;
  const { error } = await supa.from("members").delete().eq("id", id);
  if (error) { alert("Could not delete: " + error.message); return; }
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
    "Attended 2026 New Year Event": m.attended2026NewYear ? "Yes" : "No",
    "2026 Event Payment ($)": m.event2026Payment || "",
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
  const list = members.filter(m => m.category !== "Active");
  downloadWorkbook([{ name: "Not Renewed", rows: list }], `KAN_Members_Not_Renewed_${dateStamp()}.xlsx`);
}
function downloadFullReport() {
  downloadWorkbook([
    { name: "Active Members", rows: members.filter(m => m.category === "Active") },
    { name: "Members To Renew", rows: members.filter(m => m.category === "Renewal Due") },
    { name: "Not Renewed - Long Term", rows: members.filter(m => m.category === "Long Lapsed") },
  ], `KAN_Membership_Full_Report_${dateStamp()}.xlsx`);
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
  const preselect = new Set(getFiltered().filter(m => m.category !== "Active").map(m => m.id));
  renderRecipientList(preselect);
  document.getElementById("reminderModal").style.display = "flex";
}
function closeReminderModal() {
  document.getElementById("reminderModal").style.display = "none";
}

function renderRecipientList(preselectIds) {
  const channel = currentReminderChannel();
  const container = document.getElementById("reminderRecipientList");
  const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name));
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
      <span class="au-email">${escapeHtml(r.email)}${r.is_admin ? " (admin)" : ""}</span>
      <button type="button" class="remove-access-btn" data-email="${escapeHtml(r.email)}">Remove</button>
    </div>
  `).join("");
}
async function addAccessUser(email, admin) {
  const { error } = await supa.from("allowed_users").insert({ email: email.trim().toLowerCase(), is_admin: admin, added_by: currentUser.email });
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
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("noAccessScreen").style.display = "none";
  document.getElementById("appRoot").style.display = "block";
  document.getElementById("whoamiLabel").textContent = currentUser.email;
  document.getElementById("btnManageAccess").style.display = isAdmin ? "inline-block" : "none";

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
    statusEl.textContent = "Sending login link…";
    const { error } = await supa.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
    statusEl.textContent = error ? "Error: " + error.message : `Check ${email} for a login link.`;
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

  const columnFilterIds = ["colf-name", "colf-category", "colf-status", "colf-type", "colf-payment", "colf-yearRenewed", "colf-phone", "colf-email", "colf-address", "colf-household", "colf-notes", "colf-event", "colf-reminder"];
  ["searchBox", ...columnFilterIds].forEach(id => {
    document.getElementById(id).addEventListener("input", render);
    document.getElementById(id).addEventListener("change", render);
  });
  document.getElementById("btnClearFilters").addEventListener("click", () => {
    document.getElementById("searchBox").value = "";
    columnFilterIds.forEach(id => { document.getElementById(id).value = ""; });
    render();
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
  document.getElementById("btnSelectNotActive").addEventListener("click", () => selectRecipientsByPredicate(m => m.category !== "Active"));
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
    const email = document.getElementById("newAccessEmail").value;
    const admin = document.getElementById("newAccessIsAdmin").checked;
    addAccessUser(email, admin);
    document.getElementById("newAccessEmail").value = "";
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
