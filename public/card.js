/* KAN member digital-card-only page. Trimmed copy of profile.js: same auth
   (email link + code) and the same read-only card, but no edit form at all.
   This is what "Add to Home Screen" launches into (manifest.json start_url),
   so opening the installed icon goes straight to the card, not a page full
   of edit fields and a save button. Full profile editing still lives at
   profile.html — this page links out to it for anyone who wants that.
*/

let supa = null;
let currentUser = null; // { email }
let member = null;      // the signed-in member's own row, camelCase

// ---------- Supabase row <-> app field mapping (matches app.js / profile.js) ----------

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

function renderCardPage(m) {
  document.getElementById("cardWhoami").textContent = m.name ? `Signed in as ${m.name}` : "";
  renderCard(m);
  renderRenewalNote(m);
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
    document.getElementById("cardRoot").style.display = "none";
    document.getElementById("noMembershipScreen").style.display = "flex";
    document.getElementById("noMembershipEmail").textContent = currentUser.email;
    return;
  }

  const { data, error } = await supa.from("members").select("*").eq("id", memberId).maybeSingle();
  if (error || !data) {
    console.error("Could not load member row:", error);
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("cardRoot").style.display = "none";
    document.getElementById("noMembershipScreen").style.display = "flex";
    document.getElementById("noMembershipEmail").textContent = currentUser.email;
    return;
  }

  member = rowToMember(data);
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("noMembershipScreen").style.display = "none";
  document.getElementById("cardRoot").style.display = "block";
  renderCardPage(member);
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
      document.getElementById("cardRoot").style.display = "none";
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
    const otpForm = document.getElementById("otpForm");
    const otpStatusEl = document.getElementById("otpStatus");
    statusEl.className = "auth-status";
    statusEl.textContent = "Sending your login link…";
    otpStatusEl.textContent = "";
    submitBtn.disabled = true;
    const { error } = await supa.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
    submitBtn.disabled = false;
    if (error) {
      statusEl.className = "auth-status auth-status-error";
      statusEl.textContent = "Couldn't send the link: " + error.message;
      otpForm.style.display = "none";
    } else {
      statusEl.className = "auth-status auth-status-ok";
      statusEl.textContent = `Check ${email} for your login link and code. It may take a minute to arrive — check spam too.`;
      // The link only works from a regular browser tab — on a home-screen
      // icon it opens Safari instead (an iOS limitation), so surface the
      // code entry step every time a link is sent, not just on request.
      otpForm.style.display = "flex";
      const codeInput = document.getElementById("otpCode");
      codeInput.value = "";
      codeInput.focus();
    }
  });

  document.getElementById("otpForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("loginEmail").value.trim();
    const code = document.getElementById("otpCode").value.trim();
    const statusEl = document.getElementById("otpStatus");
    const submitBtn = document.querySelector("#otpForm button[type=submit]");
    if (!code) return;
    statusEl.className = "auth-status";
    statusEl.textContent = "Verifying…";
    submitBtn.disabled = true;
    const { error } = await supa.auth.verifyOtp({ email, token: code, type: "email" });
    submitBtn.disabled = false;
    if (error) {
      statusEl.className = "auth-status auth-status-error";
      statusEl.textContent = "That code didn't work: " + error.message;
      return;
    }
    // On success this sets the session, which fires onAuthStateChange below
    // and takes over — no manual redirect needed.
    statusEl.className = "auth-status auth-status-ok";
    statusEl.textContent = "Signed in.";
  });

  document.getElementById("btnResendCode").addEventListener("click", () => {
    document.getElementById("loginForm").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  });

  document.getElementById("btnChangeEmail").addEventListener("click", () => {
    document.getElementById("otpForm").style.display = "none";
    document.getElementById("otpStatus").textContent = "";
    document.getElementById("loginStatus").textContent = "";
    const emailInput = document.getElementById("loginEmail");
    emailInput.value = "";
    emailInput.focus();
  });

  document.getElementById("btnSignOut").addEventListener("click", () => supa.auth.signOut());
  document.getElementById("btnSignOutNoMembership").addEventListener("click", () => supa.auth.signOut());

  document.getElementById("btnAddHome").addEventListener("click", () => {
    const hint = document.getElementById("addHomeHint");
    hint.style.display = hint.style.display === "none" ? "block" : "none";
  });
  document.getElementById("btnPrintCard").addEventListener("click", () => window.print());
}

document.addEventListener("DOMContentLoaded", async () => {
  attachEvents();
  await initAuth();
});
