/* KAN member self-service profile page.
   Separate from app.js (the admin dashboard) on purpose: different auth
   outcome (every member, not just allowed_users), different permissions
   (own row only, contact fields only), different layout. Shares the same
   Supabase project/tables and lib/place-utils.js for "City in USA" parsing.
*/

let supa = null;
let currentUser = null; // { email }
let member = null;      // the signed-in member's own row, camelCase

// Fields a member is allowed to self-edit. Mirrors the DB trigger
// (protect_admin_only_member_fields in 006_member_self_service.sql) — that
// trigger is the real enforcement; this list just keeps the client from
// even trying to send fields it knows will be silently ignored.
const EDITABLE_FIELDS = ["email", "phone", "address", "nativePlace", "spouseName", "childrenNames", "notes"];

// ---------- Supabase row <-> app field mapping (matches app.js) ----------

function rowToMember(row) {
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
  };
}

function editableRowPayload(formValues) {
  return {
    email: formValues.email || null,
    phone: formValues.phone || null,
    address: formValues.address || null,
    native_place: formValues.nativePlace || null,
    spouse_name: formValues.spouseName || null,
    children_names: formValues.childrenNames || null,
    notes: formValues.notes || null,
  };
}

// ---------- formatting ----------

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d + "T00:00:00");
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}
function fmtYear(y) {
  if (!y) return "—";
  return String(y);
}
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function familyLine(m) {
  const parts = [];
  if (m.spouseName) parts.push(`Spouse: ${m.spouseName}`);
  if (m.childrenNames) parts.push(`Children: ${m.childrenNames}`);
  return parts.length ? parts.join(" · ") : "—";
}

// ---------- rendering ----------

function renderCard(m) {
  const active = m.category === "Active";
  const card = document.getElementById("idCard");
  card.classList.toggle("inactive", !active);

  document.getElementById("idCardBadge").textContent = active ? "ACTIVE MEMBER" : "MEMBERSHIP INACTIVE";
  document.getElementById("idCardName").textContent = m.name || "—";
  document.getElementById("idCardMeta").textContent = `${m.type || "—"} · ${m.status || m.category || "—"} Member`;

  document.getElementById("idType").textContent = m.type || "—";
  document.getElementById("idRenewed").textContent = fmtYear(m.yearRenewed);
  document.getElementById("idPayment").textContent = fmtDate(m.membershipPaymentDate);
  document.getElementById("idCity").textContent = extractUsCityName(m.address) || "—";
  document.getElementById("idNative").textContent = m.nativePlace || "—";
  document.getElementById("idFamily").textContent = familyLine(m);

  const memberIdStr = `KAN-${String(m.id).padStart(6, "0")}`;
  document.getElementById("idMemberId").textContent = memberIdStr;

  const qrData = encodeURIComponent(memberIdStr);
  document.getElementById("idQr").innerHTML =
    `<img src="https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=0&data=${qrData}" alt="Member QR code" />`;
}

function renderRenewalNote(m) {
  const el = document.getElementById("renewalNote");
  el.classList.remove("ok", "due", "lapsed");
  if (m.category === "Active") {
    el.classList.add("ok");
    el.textContent = `You're up to date — renewed for ${fmtYear(m.yearRenewed)}.`;
  } else if (m.category === "Renewal Due") {
    el.classList.add("due");
    el.textContent = "Your membership is due for renewal. Contact the treasurer to renew and your card will update automatically.";
  } else if (m.category === "Moved Out") {
    el.classList.add("lapsed");
    el.textContent = "Your record is marked as moved out. If that's no longer accurate, let the committee know.";
  } else {
    el.classList.add("lapsed");
    el.textContent = "Your membership has lapsed. Contact the treasurer to renew.";
  }
}

function renderReadOnly(m) {
  document.getElementById("ro-name").textContent = m.name || "—";
  document.getElementById("ro-status").textContent = m.status || "—";
  document.getElementById("ro-type").textContent = m.type || "—";
  document.getElementById("ro-category").textContent = m.category || "—";
  document.getElementById("ro-yearRenewed").textContent = fmtYear(m.yearRenewed);
  document.getElementById("ro-payment").textContent = fmtDate(m.membershipPaymentDate);
}

function fillForm(m) {
  document.getElementById("f-email").value = m.email || "";
  document.getElementById("f-phone").value = m.phone || "";
  document.getElementById("f-address").value = m.address || "";
  document.getElementById("f-nativePlace").value = m.nativePlace || "";
  document.getElementById("f-spouseName").value = m.spouseName || "";
  document.getElementById("f-childrenNames").value = m.childrenNames || "";
  document.getElementById("f-notes").value = m.notes || "";
}

function renderProfile(m) {
  document.getElementById("profileWhoami").textContent = m.name ? `Signed in as ${m.name}` : "";
  renderCard(m);
  renderRenewalNote(m);
  renderReadOnly(m);
  fillForm(m);
}

// ---------- auth flow ----------

async function handleAuthedSession(session) {
  currentUser = { email: session.user.email };

  const { data: memberId, error: linkErr } = await supa.rpc("link_my_member_record");
  if (linkErr) {
    console.error("link_my_member_record failed:", linkErr);
  }

  if (!memberId) {
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("profileRoot").style.display = "none";
    document.getElementById("noMembershipScreen").style.display = "flex";
    document.getElementById("noMembershipEmail").textContent = currentUser.email;
    return;
  }

  const { data, error } = await supa.from("members").select("*").eq("id", memberId).maybeSingle();
  if (error || !data) {
    console.error("Could not load member row:", error);
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("profileRoot").style.display = "none";
    document.getElementById("noMembershipScreen").style.display = "flex";
    document.getElementById("noMembershipEmail").textContent = currentUser.email;
    return;
  }

  member = rowToMember(data);
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("noMembershipScreen").style.display = "none";
  document.getElementById("profileRoot").style.display = "block";
  renderProfile(member);
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
      member = null;
      document.getElementById("profileRoot").style.display = "none";
      document.getElementById("noMembershipScreen").style.display = "none";
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
  document.getElementById("btnSignOutNoMembership").addEventListener("click", () => supa.auth.signOut());

  document.getElementById("btnAddHome").addEventListener("click", () => {
    const hint = document.getElementById("addHomeHint");
    hint.style.display = hint.style.display === "none" ? "block" : "none";
  });
  document.getElementById("btnPrintCard").addEventListener("click", () => window.print());

  document.getElementById("profileForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!member) return;
    const statusEl = document.getElementById("saveStatus");
    const submitBtn = document.querySelector("#profileForm button[type=submit]");
    const formValues = {
      email: document.getElementById("f-email").value.trim(),
      phone: document.getElementById("f-phone").value.trim(),
      address: document.getElementById("f-address").value.trim(),
      nativePlace: document.getElementById("f-nativePlace").value.trim(),
      spouseName: document.getElementById("f-spouseName").value.trim(),
      childrenNames: document.getElementById("f-childrenNames").value.trim(),
      notes: document.getElementById("f-notes").value.trim(),
    };

    submitBtn.disabled = true;
    statusEl.className = "save-status";
    statusEl.textContent = "Saving…";

    const { error } = await supa
      .from("members")
      .update(editableRowPayload(formValues))
      .eq("id", member.id);

    submitBtn.disabled = false;
    if (error) {
      statusEl.className = "save-status error";
      statusEl.textContent = "Couldn't save: " + error.message;
      return;
    }

    member = { ...member, ...formValues };
    statusEl.className = "save-status ok";
    statusEl.textContent = "Saved.";
    renderCard(member); // City/Native Place/Family on the card can change
    setTimeout(() => { statusEl.textContent = ""; }, 4000);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  attachEvents();
  await initAuth();
});
