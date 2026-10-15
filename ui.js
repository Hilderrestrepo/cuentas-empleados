// Utilidades de interfaz: formato, mensajes y formularios en ventana.

export const fmt = (n) =>
  new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(Number(n) || 0);

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Fecha de hoy en Bogotá, como AAAA-MM-DD. */
export const hoyBogota = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });

export const sumarDias = (iso, n) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Para fechas "solo día" (AAAA-MM-DD). */
export const fechaCorta = (iso) =>
  iso ? new Date(iso + "T12:00:00").toLocaleDateString("es-CO", { weekday: "short", day: "2-digit", month: "short" }) : "";

export const fechaHora = (d) =>
  new Date(d).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" });

let toastTimer;
export function toast(msg, kind = "ok") {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.className = "toast " + kind;
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), kind === "err" ? 6000 : 2500);
}

export function modal(html) {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div>${html}</div>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  m.addEventListener("click", (e) => { if (e.target === m) close(); });
  return { el: m.firstElementChild, close };
}

function campo(f) {
  const id = `f_${f.id}`;
  let ctl;
  if (f.type === "select") {
    ctl = `<select id="${id}">${f.options
      .map((o) => `<option value="${esc(o.v)}"${String(o.v) === String(f.value ?? "") ? " selected" : ""}>${esc(o.l)}</option>`)
      .join("")}</select>`;
  } else if (f.type === "textarea") {
    ctl = `<textarea id="${id}" rows="2">${esc(f.value ?? "")}</textarea>`;
  } else if (f.type === "file") {
    ctl = `<input id="${id}" type="file" accept="image/*" capture="environment">`;
  } else if (f.type === "number") {
    const step = f.step ?? 1;
    ctl = `<input id="${id}" type="number" inputmode="${step < 1 ? "decimal" : "numeric"}" min="0" step="${step}" value="${esc(f.value ?? "")}" ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ""}>`;
  } else if (f.type === "pin") {
    ctl = `<input id="${id}" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" value="${esc(f.value ?? "")}" placeholder="${esc(f.placeholder ?? "")}">`;
  } else {
    ctl = `<input id="${id}" type="${f.type || "text"}" value="${esc(f.value ?? "")}" ${f.maxlength ? `maxlength="${f.maxlength}"` : ""} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ""} ${f.type === "text" || !f.type ? 'autocapitalize="none" autocomplete="off"' : ""}>`;
  }
  return `<div class="fld" data-f="${f.id}"><label>${esc(f.label)}</label>${ctl}${f.help ? `<div class="mut" style="margin:-6px 0 8px">${esc(f.help)}</div>` : ""}</div>`;
}

/**
 * Formulario en ventana.
 * fields: [{id,label,type,value,options,required,showIf(vals),help,step,placeholder}]
 * onSubmit(valores) -> si lanza error, se muestra en la ventana; si termina bien, se cierra.
 */
export function formModal({ title, intro = "", fields, ok = "Guardar", onSubmit }) {
  const m = modal(`<h3 style="margin-top:0">${esc(title)}</h3>${intro ? `<p class="mut">${intro}</p>` : ""}
    ${fields.map(campo).join("")}
    <div class="msgbox"></div>
    <div class="grid2"><button class="btn sec" data-x>Cancelar</button><button class="btn" data-ok>${esc(ok)}</button></div>`);
  const root = m.el;

  const leer = () => {
    const v = {};
    for (const f of fields) {
      const el = root.querySelector(`#f_${f.id}`);
      if (f.type === "file") v[f.id] = el.files[0] || null;
      else if (f.type === "number") v[f.id] = el.value === "" ? null : Number(el.value);
      else v[f.id] = el.value.trim();
    }
    return v;
  };
  const refrescar = () => {
    const v = leer();
    for (const f of fields) {
      if (f.showIf) root.querySelector(`[data-f="${f.id}"]`).hidden = !f.showIf(v);
    }
  };
  root.addEventListener("input", refrescar);
  root.addEventListener("change", refrescar);
  refrescar();

  const box = root.querySelector(".msgbox");
  root.querySelector("[data-x]").onclick = m.close;
  const btn = root.querySelector("[data-ok]");
  btn.onclick = async () => {
    const v = leer();
    for (const f of fields) {
      if (f.showIf && !f.showIf(v)) { v[f.id] = undefined; continue; }
      if (f.required && (v[f.id] === null || v[f.id] === "" || v[f.id] === undefined)) {
        box.innerHTML = `<div class="msg err">Falta: ${esc(f.label)}</div>`;
        return;
      }
    }
    btn.disabled = true;
    box.innerHTML = "";
    try {
      await onSubmit(v);
      m.close();
    } catch (e) {
      box.innerHTML = `<div class="msg err">${esc(e.message || e)}</div>`;
      btn.disabled = false;
    }
  };
  setTimeout(() => root.querySelector("input,select,textarea")?.focus(), 50);
  return m;
}

/** Reduce una foto (para no gastar datos del celular). */
export async function comprimirImagen(file, max = 1280, calidad = 0.7) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("No se pudo procesar la foto"))), "image/jpeg", calidad));
}
