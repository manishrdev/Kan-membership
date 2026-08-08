/* Shared "member view" logic — the digital card, renewal note, editable
   contact form, and read-only membership panel — used by index.html for
   anyone signed in who has a member record of their own (whether or not
   they're also a board admin).

   Namespaced as window.MemberPortal to avoid colliding with app.js, which
   has its own differently-shaped rowToMember/fmtDate/fmtYear for the admin
   table (a different row shape, joined with reminder history).
*/

window.MemberPortal = (function () {

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

  // extractUsCityName comes from lib/place-utils.js, loaded before this file.

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
    document.getElementById("mro-name").textContent = m.name || "—";
    document.getElementById("mro-status").textContent = m.status || "—";
    document.getElementById("mro-type").textContent = m.type || "—";
    document.getElementById("mro-category").textContent = m.category || "—";
    document.getElementById("mro-yearRenewed").textContent = fmtYear(m.yearRenewed);
    document.getElementById("mro-payment").textContent = fmtDate(m.membershipPaymentDate);
  }

  function fillForm(m) {
    document.getElementById("mf-email").value = m.email || "";
    document.getElementById("mf-phone").value = m.phone || "";
    document.getElementById("mf-address").value = m.address || "";
    document.getElementById("mf-nativePlace").value = m.nativePlace || "";
    document.getElementById("mf-spouseName").value = m.spouseName || "";
    document.getElementById("mf-childrenNames").value = m.childrenNames || "";
    document.getElementById("mf-notes").value = m.notes || "";
  }

  function renderAll(m) {
    document.getElementById("memberWhoami").textContent = m.name ? `Signed in as ${m.name}` : "";
    renderCard(m);
    renderRenewalNote(m);
    renderReadOnly(m);
    fillForm(m);
  }

  return { rowToMember, editableRowPayload, fmtDate, fmtYear, familyLine, renderCard, renderRenewalNote, renderReadOnly, fillForm, renderAll };
})();
