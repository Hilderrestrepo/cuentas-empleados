import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { fmt, esc, hoyBogota, sumarDias, fechaCorta, fechaHora, toast, modal, formModal, comprimirImagen } from "./ui.js";
import { num, calcRuta, comisiones, resumenGanancias, estadoCartera } from "./calc.js";

const $app = document.getElementById("app");
const $nav = document.getElementById("nav");
const $title = document.getElementById("title");
const $back = document.getElementById("back");
const $out = document.getElementById("out");

if (SUPABASE_URL.startsWith("PEGAR")) {
  $app.innerHTML = `<div class="card"><b>Falta configurar.</b><p class="mut">Edita <code>config.js</code> con la URL y la key de tu proyecto Supabase.</p></div>`;
  throw new Error("config pendiente");
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

/* ------------------------------------------------------------------ */
/* Estado y utilidades                                                 */
/* ------------------------------------------------------------------ */
const S = { me: null, dir: [], cuentas: [], clientes: [], tab: null };
let H = {}, HC = {}, HI = {};   // manejadores de la vista actual: clic, cambio, escritura
let renderId = 0;

const TIPO_AJ = {
  devolucion: "Devolución", faltante: "Faltante", no_entregado: "Pedido no entregado",
  cambio: "Cambio por vencido/dañado", descuento: "Descuento / rebaja",
};
const ROL = { admin: "Administrador", vendedor: "Vendedor", entregador: "Entregador" };

const Q = async (p) => {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
};

/** Sube una foto (opcional) al bucket privado; devuelve la ruta o null si no hay foto. */
async function subirFoto(file, rutaId) {
  if (!file) return null;
  const blob = await comprimirImagen(file);
  const path = `${rutaId}/${crypto.randomUUID()}.jpg`;
  const { error } = await sb.storage.from("comprobantes").upload(path, blob, { contentType: "image/jpeg" });
  if (error) throw new Error("No se pudo subir la foto: " + error.message);
  return path;
}
// Qué tabla/columna guarda la foto de cada cosa (lista cerrada; la llave es la primaria).
const FOTO_COL = {
  facturas: ["id", "foto"], pagos_factura: ["factura_id", "foto"], ajustes: ["id", "foto"],
  cobros_cartera: ["id", "foto"], gastos_ruta: ["id", "foto"], entregas_dinero: ["id", "comprobante"],
};

// Refresco automático (vista "En vivo" y rutas abiertas que mira otra persona).
let TIMER = null;
function detenerAuto() { if (TIMER) { clearInterval(TIMER); TIMER = null; } }
function activarAuto(fn, ms = 15000) {
  detenerAuto();
  TIMER = setInterval(() => {
    if (document.hidden || document.querySelector(".modal")) return;
    Promise.resolve().then(fn).catch(() => {});
  }, ms);
}
const horaCorta = () => new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", second: "2-digit" });

const nombreDe = (id) => S.dir.find((d) => d.id === id)?.nombre || "—";
const pctDe = (id) => num(S.dir.find((d) => d.id === id)?.pct_comision);

function view(title, back = null) {
  detenerAuto();
  H = {}; HC = {}; HI = {};
  $title.textContent = title;
  $back.hidden = !back;
  $back.onclick = back;
  $app.innerHTML = `<p class="mut">Cargando…</p>`;
  window.scrollTo(0, 0);
  return ++renderId;
}
const fila = (txt, val, { fuerte = false, cls = "" } = {}) =>
  `<tr class="${fuerte ? "tot" : ""}"><td>${txt}</td><td class="r ${cls}">${val}</td></tr>`;

const run = (fn) => (...a) => Promise.resolve().then(() => fn(...a)).catch((err) => toast(err.message || String(err), "err"));
$app.addEventListener("click", (e) => {
  const b = e.target.closest("[data-a]");
  if (b && H[b.dataset.a]) run(H[b.dataset.a])(b.dataset, b);
});
$app.addEventListener("change", (e) => {
  const t = e.target.closest("[data-c]");
  if (t && HC[t.dataset.c]) run(HC[t.dataset.c])(t.value, t);
});
$app.addEventListener("input", (e) => {
  const t = e.target.closest("[data-i]");
  if (t && HI[t.dataset.i]) HI[t.dataset.i](t.value, t);
});

async function errFn(error) {
  try { const j = await error.context.json(); return j.error || error.message; } catch { return error.message || "Error de conexión"; }
}
async function llamarFn(body) {
  const { data, error } = await sb.functions.invoke("usuarios", { body });
  if (error) throw new Error(await errFn(error));
  if (data?.error) throw new Error(data.error);
  return data;
}

async function cargarBase() {
  const [dir, cuentas, clientes] = await Promise.all([
    Q(sb.rpc("directorio")),
    Q(sb.from("cuentas_banco").select("*").order("nombre")),
    Q(sb.from("clientes").select("*").order("nombre").limit(5000)),
  ]);
  S.dir = dir; S.cuentas = cuentas; S.clientes = clientes;
}

/* ------------------------------------------------------------------ */
/* Entrada (usuario + PIN) y navegación                                */
/* ------------------------------------------------------------------ */
let ULTIMO_USUARIO = "";
function authView(modo = "login", aviso = "", tipo = "err") {
  detenerAuto();
  H = {}; HC = {}; HI = {};
  renderId++;
  S.me = null; $out.hidden = true; $nav.innerHTML = ""; $nav.hidden = true;
  $title.textContent = "Cuentas Empleados"; $back.hidden = true;
  const setup = modo === "setup";
  $app.innerHTML = `<div class="card">
    ${aviso ? `<div class="msg ${tipo}">${esc(aviso)}</div>` : ""}
    <h2 style="margin-top:0">${setup ? "Crear administrador" : "Ingresar"}</h2>
    ${setup ? `<label>Tu nombre</label><input id="nombre" autocomplete="off">` : ""}
    <label>Usuario</label><input id="usuario" autocapitalize="none" autocomplete="username" value="${esc(ULTIMO_USUARIO)}">
    <label>PIN</label><input id="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off">
    ${setup ? `<p class="mut">Usuario: 3 a 30 letras minúsculas o números. PIN: de 4 a 8 dígitos (para el administrador recomiendo 6 o más).</p>` : ""}
    <button class="btn" id="go">${setup ? "Crear y entrar" : "Entrar"}</button>
    <button class="link" id="sw">${setup ? "Volver" : "Primera vez: crear el administrador"}</button>
  </div>`;
  const $ = (id) => document.getElementById(id);
  $("sw").onclick = () => authView(setup ? "login" : "setup");
  $("pin").addEventListener("keydown", (e) => { if (e.key === "Enter") $("go").click(); });
  $("go").onclick = async () => {
    const usuario = $("usuario").value.trim().toLowerCase();
    const pin = $("pin").value.trim();
    ULTIMO_USUARIO = usuario;
    $("go").disabled = true;
    try {
      if (setup) await llamarFn({ accion: "setup", nombre: $("nombre").value.trim(), usuario, pin });
      const tok = await llamarFn({ accion: "login", usuario, pin });
      const { error } = await sb.auth.setSession({ access_token: tok.access_token, refresh_token: tok.refresh_token });
      if (error) throw error;
      await boot();
    } catch (e) {
      authView(modo, e.message || String(e));
    }
  };
}

const TABS = {
  admin: [["ventas", "📊", "Ventas"], ["envivo", "🔴", "En vivo"], ["cartera", "📒", "Cartera"], ["equipo", "👥", "Equipo"], ["mas", "⚙️", "Más"]],
  entregador: [["hoy", "🚚", "Hoy"], ["ventas", "📊", "Ventas"], ["saldo", "💰", "Mi saldo"]],
  vendedor: [["ventas", "📊", "Ventas"], ["envivo", "🔴", "En vivo"], ["saldo", "💰", "Mi saldo"], ["cartera", "📒", "Cartera"]],
};
const VIEWS = {
  ventas: () => vistaVentas(), envivo: () => vistaEnVivo(), cartera: () => vistaCartera(),
  equipo: () => vistaEquipo(), mas: () => vistaMas(), hoy: () => vistaHoy(),
  saldo: () => vistaSaldo(S.me.id, true),
};

function tab(k) {
  S.tab = k;
  $nav.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.tab === k));
  VIEWS[k]().catch((e) => { $app.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; });
}
$nav.addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) tab(b.dataset.tab); });
$out.onclick = async () => { await sb.auth.signOut(); authView(); };

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return authView();
  try {
    const p = await Q(sb.from("perfiles").select("*").eq("id", session.user.id).maybeSingle());
    if (!p || !p.activo) { await sb.auth.signOut(); return authView("login", "Tu cuenta no está activa."); }
    S.me = p;
    await cargarBase();
  } catch (e) {
    await sb.auth.signOut();
    return authView("login", e.message);
  }
  $out.hidden = false;
  $nav.hidden = false;
  $nav.innerHTML = TABS[S.me.rol].map(([k, ico, txt]) => `<button data-tab="${k}"><span>${ico}</span>${txt}</button>`).join("");
  tab(TABS[S.me.rol][0][0]);
}

/* ------------------------------------------------------------------ */
/* Ventas entregadas (tabla compartida)                                */
/* ------------------------------------------------------------------ */
const VENTAS = { per: "7", grupo: "dia" };
async function vistaVentas() {
  const tok = view("Ventas");
  const { per, grupo } = VENTAS;
  const n = per === "hoy" ? 1 : Number(per);
  const desde = per === "todo" ? null : sumarDias(hoyBogota(), -(n - 1));
  const filas = await Q(sb.rpc("ventas_tabla", { p_desde: desde }));
  if (tok !== renderId) return;

  const clave = { dia: (r) => r.fecha, vendedor: (r) => r.vendedor_id, entregador: (r) => r.entregador_id }[grupo];
  const mapa = new Map();
  for (const r of filas) {
    const k = clave(r);
    const a = mapa.get(k) || { k, salida: 0, desc: 0, real: 0 };
    a.salida += num(r.salida); a.desc += num(r.descuentos); a.real += num(r.venta_real);
    mapa.set(k, a);
  }
  const rows = [...mapa.values()];
  if (grupo !== "dia") rows.sort((a, b) => b.real - a.real);
  const tot = rows.reduce((t, r) => ({ salida: t.salida + r.salida, desc: t.desc + r.desc, real: t.real + r.real }), { salida: 0, desc: 0, real: 0 });
  const dias = new Set(filas.map((r) => r.fecha)).size;
  const periodos = [["hoy", "Hoy"], ["7", "Últimos 7 días"], ["30", "Últimos 30 días"], ["90", "Últimos 3 meses"]];
  if (S.me.rol === "admin") periodos.push(["todo", "Todo"]);
  const etiqueta = (k) => (grupo === "dia" ? fechaCorta(k) : !k ? "Sin factura anotada" : esc(nombreDe(k)));

  $app.innerHTML = `
    <div class="grid2">
      <select data-c="per">${periodos.map(([v, l]) => `<option value="${v}"${v === per ? " selected" : ""}>${l}</option>`).join("")}</select>
      <select data-c="grupo">${[["dia", "Por día"], ["vendedor", "Por vendedor"], ["entregador", "Por entregador"]]
        .map(([v, l]) => `<option value="${v}"${v === grupo ? " selected" : ""}>${l}</option>`).join("")}</select>
    </div>
    <div class="grid2">
      <div class="card"><div class="mut">Venta real del período</div><div class="big">${fmt(tot.real)}</div></div>
      <div class="card"><div class="mut">Promedio por día con ruta</div><div class="big">${fmt(dias ? Math.round(tot.real / dias) : 0)}</div></div>
    </div>
    <div class="card flush">
      <table class="tabla">
        <thead><tr><th>${grupo === "dia" ? "Día" : grupo === "vendedor" ? "Vendedor" : "Entregador"}</th><th class="r">Salida</th><th class="r">Desc.</th><th class="r">Venta real</th></tr></thead>
        <tbody>${rows.length ? rows.map((r) => `<tr><td>${etiqueta(r.k)}</td><td class="r">${fmt(r.salida)}</td><td class="r">${r.desc ? "−" + fmt(r.desc) : "—"}</td><td class="r"><b>${fmt(r.real)}</b></td></tr>`).join("")
          : `<tr><td colspan="4" class="mut">Aún no hay rutas guardadas en este período.</td></tr>`}</tbody>
        ${rows.length ? `<tfoot><tr class="tot"><td>Total</td><td class="r">${fmt(tot.salida)}</td><td class="r">${tot.desc ? "−" + fmt(tot.desc) : "—"}</td><td class="r">${fmt(tot.real)}</td></tr></tfoot>` : ""}
      </table>
    </div>
    <p class="mut">Venta real = valor entregado − devoluciones, faltantes y descuentos. Solo cuentan las rutas ya guardadas.</p>`;
  HC.per = (v) => { VENTAS.per = v; vistaVentas(); };
  HC.grupo = (v) => { VENTAS.grupo = v; vistaVentas(); };
}

/* ------------------------------------------------------------------ */
/* Cartera (fiados a 7 días)                                           */
/* ------------------------------------------------------------------ */
function cardCartera(c, botones = "") {
  const e = estadoCartera(c.dias_atraso);
  return `<div class="card">
    <div class="row"><b>${esc(c.cliente)}</b><b>${fmt(c.saldo)}</b></div>
    <div class="mut">#${esc(c.factura_numero || "s/n")} · ${fechaCorta(c.fecha_factura)} · vendedor ${esc(c.vendedor)}</div>
    <div class="row"><span class="${e.cls}">${e.texto}</span>${c.telefono ? `<a href="tel:${esc(c.telefono)}">📞 ${esc(c.telefono)}</a>` : ""}</div>
    ${num(c.cobrado) > 0 ? `<div class="mut">Ya abonó ${fmt(c.cobrado)} de ${fmt(c.monto)}</div>` : ""}
    ${c.nota ? `<div class="mut">📝 ${esc(c.nota)}</div>` : ""}
    ${botones}
  </div>`;
}

/** Acciones sobre fiados. rutaId = ruta abierta donde se registran los cobros (null = pago directo del admin). */
function manejadoresCartera(lista, rutaId, recargar) {
  const buscar = (id) => lista.find((x) => x.id === id);
  H.cobrar = async (d) => {
    const c = buscar(d.id);
    const como = d.tipo === "efectivo" ? "en efectivo" : "por transferencia a la cuenta del dueño";
    if (!confirm(`¿${c.cliente} pagó ${fmt(c.saldo)} ${como}?`)) return;
    await Q(sb.from("cobros_cartera").insert({ cartera_id: c.id, ruta_id: rutaId, tipo: d.tipo, monto: c.saldo }));
    toast("Cobro registrado");
    recargar();
  };
  H.otro = (d) => {
    const c = buscar(d.id);
    formModal({
      title: `Cobro parcial · ${c.cliente}`, intro: `Saldo pendiente: ${esc(fmt(c.saldo))}`,
      fields: [
        { id: "tipo", label: "Forma de pago", type: "select", options: [{ v: "efectivo", l: "Efectivo (lo entrega el entregador)" }, { v: "transferencia", l: "Transferencia directa a la cuenta del dueño" }] },
        { id: "monto", label: "Monto cobrado", type: "number", required: true },
        ...(rutaId ? [{ id: "foto", label: "Foto del recibo (opcional)", type: "file" }] : []),
      ],
      onSubmit: async (v) => {
        if (!(v.monto > 0) || v.monto > c.saldo) throw new Error("El monto debe ser mayor a 0 y no superar el saldo");
        const foto = rutaId ? await subirFoto(v.foto, rutaId) : null;
        await Q(sb.from("cobros_cartera").insert({ cartera_id: c.id, ruta_id: rutaId, tipo: v.tipo, monto: v.monto, foto }));
        recargar();
      },
    });
  };
  H.posponer = (d) => {
    const c = buscar(d.id);
    formModal({
      title: `No pagó · ${c.cliente}`, intro: "Anota cuándo volver a cobrarle. Mientras no pague seguirá apareciendo.",
      fields: [
        { id: "vence", label: "Nueva fecha de cobro", type: "date", value: sumarDias(hoyBogota(), 7), required: true },
        { id: "nota", label: "Nota (opcional)", type: "text", placeholder: "Ej. pagó la mitad, vuelve el viernes" },
      ],
      onSubmit: async (v) => {
        await Q(sb.rpc("posponer_cartera", { p_cartera: c.id, p_vence: v.vence, p_nota: v.nota || null }));
        recargar();
      },
    });
  };
  H.fecha = (d) => {
    const c = buscar(d.id);
    formModal({
      title: `Cambiar fecha de cobro · ${c.cliente}`, intro: `Fecha actual: ${esc(fechaCorta(c.vence))}. Úsalo si el vendedor o el entregador se equivocó de fecha.`,
      fields: [
        { id: "vence", label: "Fecha de cobro correcta", type: "date", value: c.vence, required: true },
        { id: "nota", label: "Nota (opcional)", type: "text", placeholder: "Ej. corregido por el administrador" },
      ],
      onSubmit: async (v) => {
        await Q(sb.rpc("posponer_cartera", { p_cartera: c.id, p_vence: v.vence, p_nota: v.nota || null }));
        toast("Fecha actualizada");
        recargar();
      },
    });
  };
  H.directo = (d) => {
    const c = buscar(d.id);
    formModal({
      title: `Pago directo · ${c.cliente}`, intro: `Saldo pendiente: ${esc(fmt(c.saldo))}. Úsalo cuando el cliente te pagó a ti, sin pasar por el entregador.`,
      fields: [
        { id: "tipo", label: "Forma de pago", type: "select", options: [{ v: "efectivo", l: "Efectivo" }, { v: "transferencia", l: "Transferencia" }] },
        { id: "monto", label: "Monto (vacío = todo el saldo)", type: "number" },
      ],
      onSubmit: async (v) => {
        const monto = v.monto || num(c.saldo);
        if (monto <= 0 || monto > num(c.saldo)) throw new Error("Monto no válido");
        await Q(sb.from("cobros_cartera").insert({ cartera_id: c.id, ruta_id: null, tipo: v.tipo, monto }));
        recargar();
      },
    });
  };
}

const CARTERA = { filtro: "todas" };
async function vistaCartera() {
  const tok = view("Cartera");
  const pend = await Q(sb.rpc("cartera_pendiente"));
  if (tok !== renderId) return;
  const f = CARTERA.filtro;
  const lista = pend.filter((c) => f === "todas" || (f === "vencidas" && c.dias_atraso > 0) || (f === "hoy" && c.dias_atraso === 0) || (f === "proximas" && c.dias_atraso < 0));
  const total = pend.reduce((s, c) => s + num(c.saldo), 0);
  const vencido = pend.filter((c) => c.dias_atraso >= 0).reduce((s, c) => s + num(c.saldo), 0);
  const esAdmin = S.me.rol === "admin";

  const grupos = new Map();
  for (const c of lista) { const g = grupos.get(c.cliente_id) || { cliente: c.cliente, items: [] }; g.items.push(c); grupos.set(c.cliente_id, g); }

  $app.innerHTML = `
    <div class="grid2">
      <div class="card"><div class="mut">Por cobrar</div><div class="big">${fmt(total)}</div></div>
      <div class="card"><div class="mut">Ya vencido o vence hoy</div><div class="big ${vencido ? "red" : ""}">${fmt(vencido)}</div></div>
    </div>
    <select data-c="filtro">${[["todas", "Todos los fiados"], ["vencidas", "Vencidos"], ["hoy", "Vencen hoy"], ["proximas", "Por vencer"]]
      .map(([v, l]) => `<option value="${v}"${v === f ? " selected" : ""}>${l}</option>`).join("")}</select>
    ${lista.length ? [...grupos.values()].map((g) => `
      <div class="mut" style="margin:10px 4px 4px"><b>${esc(g.cliente)}</b> · ${fmt(g.items.reduce((s, c) => s + num(c.saldo), 0))}</div>
      ${g.items.map((c) => cardCartera(c, S.me.rol === "vendedor" ? "" : `<div class="grid2">
        ${esAdmin ? `<button class="btn sec sm" data-a="fecha" data-id="${c.id}">Cambiar fecha</button>` : `<button class="btn sec sm" data-a="posponer" data-id="${c.id}">Posponer</button>`}
        ${esAdmin ? `<button class="btn sm" data-a="directo" data-id="${c.id}">Pago directo</button>` : ""}</div>`)).join("")}`).join("")
      : `<div class="card mut">No hay fiados en esta lista. 🎉</div>`}`;
  HC.filtro = (v) => { CARTERA.filtro = v; vistaCartera(); };
  manejadoresCartera(pend, null, vistaCartera);
}

/* ------------------------------------------------------------------ */
/* Rutas                                                               */
/* ------------------------------------------------------------------ */
async function vistaEnVivo(silencioso = false) {
  const y = window.scrollY;
  const tok = silencioso ? ++renderId : view("En vivo");
  const abiertas = await Q(sb.from("rutas").select("id,fecha,entregador_id,creado_en,valor_cargue").eq("estado", "abierta").order("creado_en", { ascending: false }));
  const ids = abiertas.map((r) => r.id);
  const [facs, ajs, ultimas] = await Promise.all([
    ids.length ? Q(sb.from("facturas").select("ruta_id,valor").in("ruta_id", ids)) : [],
    ids.length ? Q(sb.from("ajustes").select("ruta_id,monto").in("ruta_id", ids)) : [],
    Q(sb.from("rutas").select("id,fecha,entregador_id,venta_real").eq("estado", "guardada")
      .order("fecha", { ascending: false }).order("creado_en", { ascending: false }).limit(40)),
  ]);
  if (tok !== renderId) return;
  if (silencioso) { H = {}; HC = {}; HI = {}; }
  const esAdmin = S.me.rol === "admin";
  const tarjetaAbierta = (r) => {
    const fs = facs.filter((f) => f.ruta_id === r.id);
    const salidaF = fs.reduce((t, f) => t + num(f.valor), 0);
    const salida = r.valor_cargue == null ? salidaF : Math.max(num(r.valor_cargue), salidaF);
    const desc = ajs.filter((a) => a.ruta_id === r.id).reduce((t, a) => t + num(a.monto), 0);
    return `<div class="card emp" data-a="abrir" data-id="${r.id}">
      <div class="row"><b>${esc(nombreDe(r.entregador_id))} · ${fechaCorta(r.fecha)}</b><span class="chip warn">en curso</span></div>
      <div class="mut">${fs.length} factura(s) · salida ${fmt(salida)}</div>
      <div class="row"><span class="mut">Venta real hasta ahora</span><b>${fmt(salida - desc)}</b></div></div>`;
  };
  $app.innerHTML = `
    ${esAdmin ? `<button class="btn" data-a="nueva">+ Nueva ruta</button><div style="height:12px"></div>` : ""}
    <div class="row sec-h"><h3>Rutas en curso ${abiertas.length ? `<span class="chip warn">${abiertas.length}</span>` : ""}</h3><span class="mut">Actualizado ${horaCorta()}</span></div>
    ${abiertas.length ? abiertas.map(tarjetaAbierta).join("") : `<div class="card mut">No hay rutas abiertas ahora. Esta pantalla se actualiza sola cada 15 segundos.</div>`}
    <h3 style="margin:18px 4px 6px">Rutas guardadas</h3>
    ${ultimas.length ? ultimas.map((r) => `<div class="card emp" data-a="abrir" data-id="${r.id}">
      <div class="row"><b>${fechaCorta(r.fecha)} · ${esc(nombreDe(r.entregador_id))}</b><span>Venta real ${fmt(r.venta_real)}</span></div></div>`).join("")
      : `<div class="card mut">Aún no hay rutas guardadas.</div>`}`;
  if (silencioso) window.scrollTo(0, y);
  H.abrir = (d) => rutaView(d.id, () => tab("envivo"));
  H.nueva = () => {
    const ent = S.dir.filter((d) => d.rol === "entregador" && d.activo);
    if (!ent.length) throw new Error("Primero crea un entregador en la pestaña Equipo");
    formModal({
      title: "Nueva ruta",
      fields: [
        { id: "entregador", label: "Entregador", type: "select", options: ent.map((d) => ({ v: d.id, l: d.nombre })) },
        { id: "fecha", label: "Fecha", type: "date", value: hoyBogota(), required: true },
      ],
      onSubmit: async (v) => {
        const r = await Q(sb.from("rutas").insert({ entregador_id: v.entregador, fecha: v.fecha }).select("id").single());
        rutaView(r.id, () => tab("envivo"));
      },
    });
  };
  if (!silencioso) activarAuto(() => vistaEnVivo(true));
}

async function vistaHoy() {
  const tok = view("Hoy");
  const [abierta, pend, ultimas] = await Promise.all([
    Q(sb.from("rutas").select("*").eq("entregador_id", S.me.id).eq("estado", "abierta").order("creado_en", { ascending: false }).limit(1)),
    Q(sb.rpc("cartera_pendiente")),
    Q(sb.from("rutas").select("id,fecha,venta_real").eq("entregador_id", S.me.id).eq("estado", "guardada").order("fecha", { ascending: false }).limit(10)),
  ]);
  if (tok !== renderId) return;
  const ruta = abierta[0] || null;
  const cobros = pend.filter((c) => c.dias_atraso >= 0).sort((a, b) => b.dias_atraso - a.dias_atraso);

  const botonesCobro = (c) => ruta
    ? `<div class="grid2"><button class="btn sm" data-a="cobrar" data-tipo="efectivo" data-id="${c.id}">Pagó en efectivo</button>
       <button class="btn sm" data-a="cobrar" data-tipo="transferencia" data-id="${c.id}">Pagó por transf.</button></div>
       <div class="grid2"><button class="btn sec sm" data-a="otro" data-id="${c.id}">Pagó una parte</button>
       <button class="btn sec sm" data-a="posponer" data-id="${c.id}">No pagó</button></div>`
    : `<button class="btn sec sm" data-a="posponer" data-id="${c.id}">No pagó / posponer</button>`;

  $app.innerHTML = `
    ${ruta ? `<div class="card emp" data-a="continuar" data-id="${ruta.id}">
        <div class="row"><b>Ruta abierta · ${fechaCorta(ruta.fecha)}</b><span class="chip warn">sin guardar</span></div>
        <div class="mut">Toca para continuar con facturas, descuentos, cobros y entrega de dinero.</div></div>`
      : `<button class="btn" data-a="abrirRuta">+ Abrir ruta de hoy</button>`}
    <h3 style="margin:18px 4px 6px">Cobros de hoy ${cobros.length ? `<span class="chip warn">${cobros.length}</span>` : ""}</h3>
    ${!ruta && cobros.length ? `<div class="msg err">Abre la ruta de hoy para registrar los cobros.</div>` : ""}
    ${cobros.length ? cobros.map((c) => cardCartera(c, botonesCobro(c))).join("") : `<div class="card mut">No hay fiados por cobrar hoy.</div>`}
    <h3 style="margin:18px 4px 6px">Mis últimas rutas</h3>
    ${ultimas.length ? ultimas.map((r) => `<div class="card emp" data-a="ver" data-id="${r.id}"><div class="row"><b>${fechaCorta(r.fecha)}</b><span>Venta real ${fmt(r.venta_real)}</span></div></div>`).join("")
      : `<div class="card mut">Todavía no has guardado rutas.</div>`}`;

  H.abrirRuta = async () => {
    const r = await Q(sb.from("rutas").insert({ entregador_id: S.me.id }).select("id").single());
    rutaView(r.id, () => tab("hoy"));
  };
  H.continuar = (d) => rutaView(d.id, () => tab("hoy"));
  H.ver = (d) => rutaView(d.id, () => tab("hoy"));
  manejadoresCartera(pend, ruta?.id ?? null, vistaHoy);
}

/* ------------------------------------------------------------------ */
/* Detalle de ruta (cierre)                                            */
/* ------------------------------------------------------------------ */
async function rutaView(id, volver, silencioso = false) {
  volver = volver || (() => tab(S.tab));
  const y = window.scrollY;
  const tok = silencioso ? ++renderId : view("Ruta", volver);
  const ruta = await Q(sb.from("rutas").select("*").eq("id", id).single());
  const esAdmin = S.me.rol === "admin";
  const esDueno = ruta.entregador_id === S.me.id;
  // Admin ve todo; cada entregador lo suyo; el vendedor solo lo de su entregador (en lectura).
  const esDinero = S.me.rol !== "entregador" || esDueno;
  const guardada = ruta.estado === "guardada";
  const editable = !guardada && (esAdmin || esDueno);
  const soloMira = !esAdmin && !esDueno;
  const vacio = Promise.resolve([]);
  const [facturas, ajustes, pagos, cobros, entregas, gastos, libro, carteraPend] = await Promise.all([
    Q(sb.from("facturas").select("*, cliente:clientes(nombre)").eq("ruta_id", id).order("creado_en")),
    Q(sb.from("ajustes").select("*").eq("ruta_id", id).order("creado_en")),
    esDinero ? Q(sb.from("pagos_factura").select("*").eq("ruta_id", id)) : vacio,
    esDinero ? Q(sb.from("cobros_cartera").select("*, cartera:cartera(monto, cliente:clientes(nombre), factura:facturas(numero))").eq("ruta_id", id).order("creado_en")) : vacio,
    esDinero ? Q(sb.from("entregas_dinero").select("*").eq("ruta_id", id).order("creado_en")) : vacio,
    esDinero ? Q(sb.from("gastos_ruta").select("*").eq("ruta_id", id).order("creado_en")) : vacio,
    guardada && esDinero ? Q(sb.from("libro").select("*").eq("ruta_id", id)) : vacio,
    editable && esDinero ? Q(sb.rpc("cartera_pendiente")) : vacio,
  ]);
  if (tok !== renderId) return;
  if (silencioso) { H = {}; HC = {}; HI = {}; }
  const recargar = () => rutaView(id, volver);
  const C = calcRuta({ facturas, ajustes, pagos, cobros, entregas, gastos, base: ruta.base, cargue: ruta.valor_cargue });
  const entNombre = nombreDe(ruta.entregador_id);
  // Clientes por cobrar: fiados que ya vencieron (o vencen hoy) y todavía no se resolvieron en este cierre.
  // Se resuelven cobrando o con "No pagó" + nueva fecha (así dejan de estar vencidos).
  const porCobrar = carteraPend.filter((c) => c.vence <= ruta.fecha && !cobros.some((x) => x.cartera_id === c.id));
  const bloqueaCobros = porCobrar.length > 0 && !esAdmin;
  $title.textContent = `${fechaCorta(ruta.fecha)} · ${entNombre}`;

  /* --- resumen --- */
  const filas = [
    fila(C.hayCargue ? "Salida (cargue)" : "Salida (facturas)", fmt(C.salidaTotal)),
    fila("− Devoluciones y faltantes", "−" + fmt(C.descuentos)),
    fila("= Venta real entregada", fmt(C.real), { fuerte: true }),
  ];
  if (esDinero) {
    filas.push(
      fila("Cobrado en efectivo (facturas)", fmt(C.efectivoFact)),
      ...(C.sinFacturas > 0 ? [fila("+ Resto del cargue sin facturas (se cuenta como efectivo)", fmt(C.sinFacturas))] : []),
      fila("+ Fiados anteriores cobrados (efectivo)", fmt(C.cobrosEf)),
      fila("− Gastos de ruta", "−" + fmt(C.gastos)),
      ...(C.base > 0 ? [fila("+ Base con la que salió (se devuelve)", fmt(C.base))] : []),
      fila("= Debe entregar", fmt(C.esperado), { fuerte: true }),
      fila("− Entregado (efectivo y consignaciones)", "−" + fmt(C.entregado)),
      fila(C.diferencia > 0 ? "= Faltante (pasa a pendiente de otros turnos)" : C.diferencia < 0 ? "= Sobrante (a favor, otros turnos)" : "= Diferencia", fmt(Math.abs(C.diferencia)),
        { fuerte: true, cls: C.diferencia > 0 ? "red" : "grn" }),
    );
  }

  /* --- comisiones --- */
  let comHtml = "";
  const vendAtado = S.dir.find((d) => d.id === ruta.vendedor_id)
    || S.dir.find((d) => d.rol === "vendedor" && d.entregador_id === ruta.entregador_id && d.activo);
  if ((esAdmin || esDueno) && !guardada && (facturas.length || ruta.valor_cargue != null || entregas.length)) {
    const K = comisiones(C, pctDe(ruta.entregador_id), vendAtado ? vendAtado.pct_comision : null);
    const desc = C.faltanteEntregador;
    comHtml = `<div class="card"><b>Comisiones estimadas</b>
      <table class="tabla">
        ${fila(`Entregador ${esc(entNombre)} (${pctDe(ruta.entregador_id)}%)`, fmt(K.entregador))}
        ${S.me.rol === "admin" ? (vendAtado ? fila(`Vendedor ${esc(vendAtado.nombre)} (${num(vendAtado.pct_comision)}%) · estimada`, fmt(K.vendedor)) : fila("Vendedor", "sin vendedor atado")) : ""}
        ${desc > 0 ? fila("Descuentos al entregador (faltantes)", "−" + fmt(desc), { cls: "red" }) : ""}
      </table><div class="mut">Las dos comisiones se miden sobre la venta real de la ruta. Se calculan de verdad al guardar.</div></div>`;
  } else if (guardada && esDinero && libro.length) {
    comHtml = `<div class="card"><b>Comisiones y descuentos de esta ruta</b><table class="tabla">
      ${libro.map((l) => fila(`${esc(nombreDe(l.empleado_id))} · ${l.tipo === "comision" ? `comisión ${num(l.pct)}% sobre ${fmt(l.base)}` : esc(l.nota || "Descuento")}`,
        (l.tipo === "comision" ? "" : "−") + fmt(l.monto), { cls: l.tipo === "comision" ? "" : "red" })).join("")}
      ${esAdmin && vendAtado && !libro.some((l) => l.empleado_id === vendAtado.id && l.tipo === "comision")
        ? fila(`Vendedor ${esc(vendAtado.nombre)} · sin comisión registrada (estimada ${num(vendAtado.pct_comision)}%)`, fmt(Math.round(num(ruta.venta_real) * num(vendAtado.pct_comision) / 100)), { cls: "red" }) : ""}</table>
      ${esAdmin && vendAtado && !libro.some((l) => l.empleado_id === vendAtado.id && l.tipo === "comision")
        ? `<div class="mut">Para dársela: en la ficha del vendedor usa "Sincronizar ventas anteriores", o reabre esta ruta y vuelve a guardarla.</div>` : ""}</div>`;
  }

  /* --- fotos (siempre opcionales) --- */
  const fotoUI = (tabla, rowId, actual) => actual
    ? `<button class="link inline" data-a="foto" data-path="${esc(actual)}">📷 ver foto</button>`
    : (editable ? `<button class="link inline" data-a="addFoto" data-t="${tabla}" data-id="${rowId}">📷 agregar foto</button>` : "");

  /* --- facturas --- */
  const facHtml = C.porFactura.map((pf) => {
    const f = facturas.find((x) => x.id === pf.id);
    const ajs = ajustes.filter((a) => a.factura_id === f.id);
    const pago = pagos.find((p) => p.factura_id === f.id);
    return `<div class="card">
      <div class="row"><b>#${esc(f.numero || "s/n")} · ${esc(f.cliente?.nombre)}</b><b>${fmt(f.valor)}</b></div>
      <div class="mut">Vendedor: ${esc(nombreDe(f.vendedor_id))}</div>
      ${ajs.map((a) => `<div class="row mut"><span>− ${TIPO_AJ[a.tipo]}${a.nota ? " · " + esc(a.nota) : ""}</span><span>${fmt(a.monto)}</span></div>`).join("")}
      ${esDinero ? `<div class="mut">Efectivo ${fmt(pf.ef)} · Transferencia ${fmt(pf.tr)} · <b>Fiado ${fmt(Math.max(pf.fiado, 0))}</b></div>
        ${pf.fiado > 0 ? `<div class="mut">Factura firmada: ${fotoUI("facturas", f.id, f.foto) || "—"}</div>` : ""}
        ${num(pf.tr) > 0 ? `<div class="mut">Comprobante de la transferencia: ${fotoUI("pagos_factura", f.id, pago?.foto) || "—"}</div>` : ""}` : ""}
      ${pf.error ? `<div class="msg err">${esc(pf.error)}</div>` : ""}
      ${editable ? `<div class="grid2"><button class="btn sec sm" data-a="editFac" data-id="${f.id}">Editar</button>
        <button class="btn danger sm" data-a="delFac" data-id="${f.id}">Borrar</button></div>` : ""}
    </div>`;
  }).join("");

  const devHtml = ajustes.map((a) => {
    const f = a.factura_id ? facturas.find((x) => x.id === a.factura_id) : null;
    const quien = f ? `factura #${esc(f.numero || "s/n")} · ${esc(f.cliente?.nombre || "")}` : `factura #${esc(a.numero_factura || "s/n")}`;
    return `<div class="row mut"><span>${TIPO_AJ[a.tipo] || a.tipo} · ${quien}${a.nota ? " · " + esc(a.nota) : ""} ${fotoUI("ajustes", a.id, a.foto)}</span>
      <span>−${fmt(a.monto)} ${editable ? `<button class="x" data-a="editAj" data-id="${a.id}" aria-label="Editar">✎</button><button class="x" data-a="delAj" data-id="${a.id}" aria-label="Quitar">✕</button>` : ""}</span></div>`;
  }).join("");
  const cobHtml = cobros.map((c) => `<div class="row mut"><span>${esc(c.cartera?.cliente?.nombre)} · #${esc(c.cartera?.factura?.numero || "s/n")} · ${c.tipo === "efectivo" ? "efectivo" : "transferencia directa"} ${fotoUI("cobros_cartera", c.id, c.foto)}</span>
    <span>${fmt(c.monto)} ${editable ? `<button class="x" data-a="editCobro" data-id="${c.id}" aria-label="Editar">✎</button><button class="x" data-a="delCobro" data-id="${c.id}">✕</button>` : ""}</span></div>`).join("");
  const entHtml = entregas.map((e) => `<div class="row mut"><span>${e.tipo === "efectivo" ? "Efectivo en mano" : "Consignación · " + esc(e.banco || S.cuentas.find((x) => x.id === e.cuenta_id)?.nombre || "")}
    ${e.tipo === "consignacion" ? fotoUI("entregas_dinero", e.id, e.comprobante) : ""}</span>
    <span>${fmt(e.monto)} ${editable ? `<button class="x" data-a="editEntrega" data-id="${e.id}" aria-label="Editar">✎</button><button class="x" data-a="delEntrega" data-id="${e.id}">✕</button>` : ""}</span></div>`).join("");
  const gasHtml = gastos.map((g) => `<div class="row mut"><span>${esc(g.concepto)}${g.nota ? " · " + esc(g.nota) : ""} ${fotoUI("gastos_ruta", g.id, g.foto)}</span>
    <span>${fmt(g.monto)} ${editable ? `<button class="x" data-a="editGasto" data-id="${g.id}" aria-label="Editar">✎</button><button class="x" data-a="delGasto" data-id="${g.id}">✕</button>` : ""}</span></div>`).join("");

  $app.innerHTML = `
    <div class="chip ${guardada ? "" : "warn"}" style="margin-bottom:8px">${guardada ? "✔ Guardada" + (ruta.guardada_en ? " · " + fechaHora(ruta.guardada_en) : "") : "Abierta · en captura"}</div>
    ${soloMira && !guardada ? `<div class="msg">👀 Solo lectura · se actualiza sola cada 15 segundos (última: ${horaCorta()})</div>` : ""}
    ${C.errores.length ? `<div class="msg err">Hay ${C.errores.length} factura(s) con errores. Corrígelas antes de guardar.</div>` : ""}
    <div class="card"><div class="row"><b>Cargue y base</b>${editable ? `<button class="btn sm auto" data-a="editCargue">${ruta.valor_cargue == null && !num(ruta.base) ? "Anotar" : "Editar"}</button>` : ""}</div>
      <table class="tabla">${fila("Valor del cargue", ruta.valor_cargue == null ? "—" : fmt(ruta.valor_cargue))}${fila("Base (efectivo con el que sale)", fmt(ruta.base))}</table>
</div>
    <div class="card"><table class="tabla">${filas.join("")}</table>
      ${esDinero ? `<div class="mut" style="margin-top:6px">Fiado nuevo (queda por cobrar): ${fmt(C.fiadoNuevo)} · Transferencias directas: ${fmt(C.transfFact + C.cobrosTr)}</div>` : ""}</div>
    ${comHtml}
    ${editable && esDinero && porCobrar.length ? `<div class="card"><b>Clientes por cobrar (${porCobrar.length})</b>
      <div class="mut">${esAdmin ? "Pendientes de cobro. Como administrador puedes cerrar igual." : "Para finalizar, marca cada cliente: pagó, o no pagó con otra fecha."}</div></div>
      ${porCobrar.map((c) => cardCartera(c, `<div class="grid2"><button class="btn sm" data-a="cobrar" data-tipo="efectivo" data-id="${c.id}">Pagó en efectivo</button>
        <button class="btn sm" data-a="cobrar" data-tipo="transferencia" data-id="${c.id}">Pagó por transf.</button></div>
        <div class="grid2"><button class="btn sec sm" data-a="otro" data-id="${c.id}">Pagó una parte</button>
        <button class="btn sec sm" data-a="posponer" data-id="${c.id}">No pagó</button></div>`)).join("")}` : ""}
    <div class="row sec-h"><h3>Facturas (${facturas.length})</h3>${editable ? `<div class="grid2" style="width:auto;gap:6px"><button class="btn sec sm auto" data-a="addCliente">+ Cliente</button><button class="btn sm auto" data-a="addFac">+ Factura</button></div>` : ""}</div>
    ${facHtml || `<div class="card mut">Sin facturas.</div>`}
    <div class="card"><div class="row"><b>Devoluciones y faltantes</b>${editable ? `<button class="btn sm auto" data-a="addAj">+ Devolución</button>` : ""}</div>${devHtml || `<div class="mut">Ninguna.</div>`}</div>
    ${esDinero ? `
    <div class="card"><div class="row"><b>Cobros de fiados anteriores</b>${editable ? `<button class="btn sm auto" data-a="addCobro">+ Cobro</button>` : ""}</div>${cobHtml || `<div class="mut">Ninguno.</div>`}</div>
    <div class="card"><div class="row"><b>Entrega de dinero</b></div>
      ${editable ? `<div class="grid2" style="margin:8px 0"><button class="btn sm" data-a="addEfectivo">+ Efectivo</button><button class="btn sm" data-a="addConsig">+ Consignación</button></div>` : ""}${entHtml || `<div class="mut">Ninguna.</div>`}</div>
    <div class="card"><div class="row"><b>Gastos de ruta</b>${editable ? `<button class="btn sm auto" data-a="addGasto">+ Gasto</button>` : ""}</div>${gasHtml || `<div class="mut">Ninguno.</div>`}</div>` : ""}
    ${editable && bloqueaCobros ? `<div class="msg err">Faltan ${porCobrar.length} cliente(s) por cobrar. Marca si pagó o si no pagó (con nueva fecha) para poder finalizar.</div>` : ""}
    ${editable ? `<button class="btn" data-a="guardar"${bloqueaCobros ? " disabled" : ""}>Guardar cierre</button>
       <p class="mut">Después de guardar no se puede modificar ni borrar nada. Solo el administrador puede reabrirlo.</p>
       <button class="link" style="color:var(--red)" data-a="borrarRuta">Borrar esta ruta</button>` : ""}
    ${guardada && S.me.rol === "admin" ? `<button class="btn sec" data-a="reabrir">Reabrir para corregir (administrador)</button>` : ""}`;
  if (silencioso) window.scrollTo(0, y);
  const auto = !guardada && !esDueno;   // otro (admin o vendedor) mirando una ruta abierta
  if (!auto) { if (silencioso) detenerAuto(); }
  else if (!silencioso) activarAuto(() => rutaView(id, volver, true));

  /* --- manejadores --- */
  const fPorId = (i) => facturas.find((f) => f.id === i);
  const confirmarBorrar = async (tabla, i, msg = "¿Borrar?") => {
    if (!confirm(msg)) return;
    await Q(sb.from(tabla).delete().eq("id", i));
    recargar();
  };
  H.delAj = (d) => confirmarBorrar("ajustes", d.id, "¿Quitar este descuento?");
  H.delFac = (d) => confirmarBorrar("facturas", d.id, "¿Borrar la factura y todo lo anotado en ella?");
  H.delCobro = (d) => confirmarBorrar("cobros_cartera", d.id, "¿Quitar este cobro?");
  H.delEntrega = (d) => confirmarBorrar("entregas_dinero", d.id, "¿Quitar esta entrega?");
  H.delGasto = (d) => confirmarBorrar("gastos_ruta", d.id, "¿Quitar este gasto?");

  const facturaForm = (f) => {
    // El vendedor sale solo del entregador de la ruta; si no hay uno atado, se escoge de la lista.
    const vendedores = S.dir.filter((d) => (d.rol === "vendedor" || d.rol === "admin") && d.activo)
      .sort((a, b) => (a.rol === "admin") - (b.rol === "admin"));
    if (!vendAtado && !vendedores.length) throw new Error("Primero crea un vendedor en la pestaña Equipo");
    const pf = f ? C.porFactura.find((x) => x.id === f.id) : null;
    const clientes = S.clientes.filter((c) => c.activo || (f && c.id === f.cliente_id));
    formModal({
      title: f ? "Editar factura" : "Nueva factura",
      fields: [
        { id: "numero", label: "Número de factura", type: "text", value: f?.numero ?? "" },
        { id: "cliente", label: "Cliente", type: "select", value: f?.cliente_id ?? "", options: [{ v: "", l: "➕ Cliente nuevo…" }, ...clientes.map((c) => ({ v: c.id, l: c.nombre }))] },
        { id: "cliente_nuevo", label: "Nombre del cliente nuevo", type: "text", showIf: (v) => v.cliente === "" },
        ...(vendAtado ? [] : [{ id: "vendedor", label: "Vendedor que la vendió", type: "select", value: f?.vendedor_id ?? vendedores[0].id, options: vendedores.map((d) => ({ v: d.id, l: d.nombre })) }]),
        { id: "valor", label: "Valor de la factura", type: "number", value: f?.valor ?? "", required: true },
        { id: "efectivo", label: "Cobró en efectivo", type: "number", value: pf?.ef || "" },
        { id: "transferencia", label: "Cliente transfirió a la cuenta del dueño", type: "number", value: pf?.tr || "" },
        { id: "foto_firma", label: "📷 Factura firmada por el cliente (opcional)", type: "file", showIf: (v) => num(v.valor) - (f ? pf.aj : 0) - num(v.efectivo) - num(v.transferencia) > 0 },
        { id: "foto_comp", label: "📷 Comprobante de la transferencia (opcional)", type: "file", showIf: (v) => num(v.transferencia) > 0 },
      ],
      intro: "Lo que no se cobre queda automáticamente como fiado a 7 días (o el plazo del cliente).",
      onSubmit: async (v) => {
        if (!(v.valor > 0)) throw new Error("El valor debe ser mayor a 0");
        let clienteId = v.cliente;
        if (!clienteId) {
          if (!v.cliente_nuevo) throw new Error("Escribe el nombre del cliente");
          const c = await Q(sb.from("clientes").insert({ nombre: v.cliente_nuevo }).select().single());
          S.clientes.push(c); clienteId = c.id;
        }
        const ajTot = f ? pf.aj : 0;
        if (num(v.efectivo) + num(v.transferencia) > v.valor - ajTot) throw new Error("Lo cobrado supera la venta real de esta factura");
        let fid = f?.id;
        const datos = { numero: v.numero || null, cliente_id: clienteId, vendedor_id: vendAtado ? (f?.vendedor_id ?? vendAtado.id) : v.vendedor, valor: v.valor };
        const fFirma = await subirFoto(v.foto_firma, id);
        const fComp = await subirFoto(v.foto_comp, id);
        if (fFirma) datos.foto = fFirma;
        if (f) await Q(sb.from("facturas").update(datos).eq("id", f.id));
        else fid = (await Q(sb.from("facturas").insert({ ruta_id: id, ...datos }).select("id").single())).id;
        await Q(sb.from("pagos_factura").upsert({ factura_id: fid, ruta_id: id, efectivo: num(v.efectivo), transferencia: num(v.transferencia), ...(fComp ? { foto: fComp } : {}) }, { onConflict: "factura_id" }));
        recargar();
      },
    });
  };
  H.addFac = () => facturaForm(null);
  H.editFac = (d) => facturaForm(fPorId(d.id));

  const ajusteForm = (a) => {
    const fAnt = a?.factura_id ? facturas.find((x) => x.id === a.factura_id) : null;
    formModal({
      title: a ? "Editar devolución" : "Devolución",
      intro: "El número es el de la factura de tu sistema POS donde se hace la devolución. El valor se descuenta del cargue.",
      fields: [
        { id: "numero", label: "Número de factura", type: "text", value: a?.numero_factura ?? fAnt?.numero ?? "", required: true },
        { id: "monto", label: "Valor", type: "number", value: a?.monto ?? "", required: true },
        { id: "foto", label: "📷 Foto del producto (opcional)", type: "file" },
      ],
      onSubmit: async (v) => {
        const maximo = C.real + (a ? num(a.monto) : 0);
        if (!(v.monto > 0)) throw new Error("El valor debe ser mayor a 0");
        if (v.monto > maximo) throw new Error(`El valor no puede superar la venta de la ruta (${fmt(maximo)})`);
        const foto = await subirFoto(v.foto, id);
        const datos = { numero_factura: v.numero, monto: v.monto, ...(foto ? { foto } : {}) };
        if (a) await Q(sb.from("ajustes").update(datos).eq("id", a.id));
        else await Q(sb.from("ajustes").insert({ ruta_id: id, tipo: "devolucion", responsable: "bodega", ...datos }));
        recargar();
      },
    });
  };
  H.addAj = () => ajusteForm(null);
  H.editAj = (d) => ajusteForm(ajustes.find((x) => x.id === d.id));

  H.editCargue = () => formModal({
    title: "Cargue y base",
    intro: "Anota lo que te entregaron para vender y el efectivo con el que sales. La base se suma a lo que debes entregar al final.",
    fields: [
      { id: "cargue", label: "Valor del cargue", type: "number", value: ruta.valor_cargue ?? "" },
      { id: "base", label: "Base (efectivo con el que sales)", type: "number", value: ruta.base || "" },
    ],
    onSubmit: async (v) => {
      await Q(sb.from("rutas").update({ valor_cargue: v.cargue, base: v.base || 0 }).eq("id", id));
      recargar();
    },
  });

  H.addCliente = () => formModal({
    title: "Cliente nuevo",
    fields: [
      { id: "nombre", label: "Nombre", type: "text", required: true },
      { id: "telefono", label: "Teléfono (opcional)", type: "text" },
      { id: "plazo", label: "Días para pagar el fiado", type: "number", value: 7, required: true },
    ],
    onSubmit: async (v) => {
      if (S.clientes.some((c) => c.nombre.trim().toLowerCase() === v.nombre.toLowerCase())) throw new Error("Ese cliente ya existe: elígelo en la lista al crear la factura");
      if (v.plazo > 90) throw new Error("El plazo máximo es 90 días");
      const c = await Q(sb.from("clientes").insert({ nombre: v.nombre, telefono: v.telefono || null, plazo_dias: v.plazo }).select().single());
      S.clientes.push(c);
      toast("Cliente agregado: ya sale en la lista de clientes de la factura");
    },
  });

  H.editCobro = (d) => {
    const c = cobros.find((x) => x.id === d.id);
    formModal({
      title: "Editar cobro", intro: `${esc(c.cartera?.cliente?.nombre || "")} · #${esc(c.cartera?.factura?.numero || "s/n")}`,
      fields: [
        { id: "tipo", label: "Forma de pago", type: "select", value: c.tipo, options: [{ v: "efectivo", l: "Efectivo (lo entrego yo)" }, { v: "transferencia", l: "Transferencia directa a la cuenta del dueño" }] },
        { id: "monto", label: "Monto", type: "number", value: c.monto, required: true },
      ],
      onSubmit: async (v) => {
        if (!(v.monto > 0)) throw new Error("El valor debe ser mayor a 0");
        await Q(sb.from("cobros_cartera").update({ tipo: v.tipo, monto: v.monto }).eq("id", c.id));
        recargar();
      },
    });
  };

  H.addCobro = async () => {
    const pend = await Q(sb.rpc("cartera_pendiente"));
    if (!pend.length) throw new Error("No hay fiados pendientes por cobrar");
    formModal({
      title: "Cobro de un fiado anterior",
      fields: [
        { id: "cartera", label: "Fiado", type: "select", options: pend.map((c) => ({ v: c.id, l: `${c.cliente} · #${c.factura_numero || "s/n"} · ${fmt(c.saldo)} · ${estadoCartera(c.dias_atraso).texto}` })) },
        { id: "tipo", label: "Forma de pago", type: "select", options: [{ v: "efectivo", l: "Efectivo (lo entrego yo)" }, { v: "transferencia", l: "Transferencia directa a la cuenta del dueño" }] },
        { id: "monto", label: "Monto (vacío = todo el saldo)", type: "number" },
        { id: "foto", label: "📷 Foto del recibo (opcional)", type: "file" },
      ],
      onSubmit: async (v) => {
        const c = pend.find((x) => x.id === v.cartera);
        const monto = v.monto || num(c.saldo);
        if (monto <= 0 || monto > num(c.saldo)) throw new Error("Monto no válido");
        const foto = await subirFoto(v.foto, id);
        await Q(sb.from("cobros_cartera").insert({ cartera_id: c.id, ruta_id: id, tipo: v.tipo, monto, foto }));
        recargar();
      },
    });
  };

  const BANCOS = ["Nequi", "Bancolombia", "Banco de Bogotá"];
  // tipoFijo: "efectivo" | "consignacion". Cada consignación se anota por separado.
  const entregaForm = (e, tipoFijo) => {
    const tipo = e ? e.tipo : tipoFijo;
    const consig = tipo === "consignacion";
    formModal({
      title: e ? (consig ? "Editar consignación" : "Editar efectivo entregado") : (consig ? "Nueva consignación" : "Efectivo en mano"),
      fields: [
        ...(consig ? [{ id: "banco", label: "Banco", type: "select", value: e?.banco ?? "", required: true, options: [{ v: "", l: "Escoge el banco…" }, ...BANCOS.map((b) => ({ v: b, l: b }))] }] : []),
        { id: "monto", label: "Valor", type: "number", value: e?.monto ?? "", required: true },
        ...(consig ? [{ id: "foto", label: "📷 Foto del comprobante (opcional)", type: "file" }] : []),
        { id: "nota", label: "Nota (opcional)", type: "text", value: e?.nota ?? "" },
      ],
      onSubmit: async (v) => {
        if (!(v.monto > 0)) throw new Error("El valor debe ser mayor a 0");
        if (consig && !BANCOS.includes(v.banco)) throw new Error("Escoge el banco");
        const path = consig ? await subirFoto(v.foto, id) : null;
        const datos = { tipo, monto: v.monto, banco: consig ? v.banco : null, cuenta_id: null, nota: v.nota || null };
        if (e) await Q(sb.from("entregas_dinero").update({ ...datos, ...(path ? { comprobante: path } : {}) }).eq("id", e.id));
        else await Q(sb.from("entregas_dinero").insert({ ruta_id: id, ...datos, comprobante: path }));
        recargar();
      },
    });
  };
  H.addEfectivo = () => entregaForm(null, "efectivo");
  H.addConsig = () => entregaForm(null, "consignacion");
  H.editEntrega = (d) => entregaForm(entregas.find((x) => x.id === d.id));
  H.foto = async (d) => {
    const { data, error } = await sb.storage.from("comprobantes").createSignedUrl(d.path, 300);
    if (error) throw new Error("No se pudo abrir la foto");
    const m = modal(`<img src="${data.signedUrl}" alt="Comprobante" style="width:100%;border-radius:10px"><button class="btn" style="margin-top:10px" data-x>Cerrar</button>`);
    m.el.querySelector("[data-x]").onclick = m.close;
  };

  H.addFoto = (d) => {
    const map = FOTO_COL[d.t];
    if (!map) throw new Error("Tipo de foto no válido");
    formModal({
      title: "Agregar foto", ok: "Subir",
      fields: [{ id: "foto", label: "Foto", type: "file", required: true }],
      onSubmit: async (v) => {
        const path = await subirFoto(v.foto, id);
        await Q(sb.from(d.t).update({ [map[1]]: path }).eq(map[0], d.id));
        recargar();
      },
    });
  };

  const gastoForm = (g) => formModal({
    title: g ? "Editar gasto" : "Gasto de ruta",
    fields: [
      { id: "concepto", label: "Concepto", type: "select", value: g?.concepto ?? "Gasolina", options: ["Gasolina", "Peajes", "Almuerzo", "Parqueadero", "Reparación", "Otro"].map((x) => ({ v: x, l: x })) },
      { id: "monto", label: "Valor", type: "number", value: g?.monto ?? "", required: true },
      { id: "nota", label: "Nota (opcional)", type: "text", value: g?.nota ?? "" },
      { id: "foto", label: "📷 Foto del tiquete (opcional)", type: "file" },
    ],
    onSubmit: async (v) => {
      if (!(v.monto > 0)) throw new Error("El valor debe ser mayor a 0");
      const foto = await subirFoto(v.foto, id);
      const datos = { concepto: v.concepto, monto: v.monto, nota: v.nota || null, ...(foto ? { foto } : {}) };
      if (g) await Q(sb.from("gastos_ruta").update(datos).eq("id", g.id));
      else await Q(sb.from("gastos_ruta").insert({ ruta_id: id, ...datos }));
      recargar();
    },
  });
  H.addGasto = () => gastoForm(null);
  H.editGasto = (d) => gastoForm(gastos.find((x) => x.id === d.id));

  if (editable && esDinero) manejadoresCartera(carteraPend, id, recargar);
  H.guardar = async () => {
    if (C.errores.length) throw new Error("Corrige las facturas marcadas en rojo antes de guardar");
    if (!facturas.length && !cobros.length && ruta.valor_cargue == null && !entregas.length) throw new Error("Anota el cargue, una factura, un cobro o la entrega de dinero antes de guardar");
    if (bloqueaCobros) throw new Error(`Faltan ${porCobrar.length} cliente(s) por cobrar: marca si pagó o si no pagó (con nueva fecha)`);
    let aviso = "¿Guardar el cierre?\n\nDespués de guardar NO se puede modificar ni borrar nada. Solo el administrador puede reabrirlo.";
    if (porCobrar.length && esAdmin) aviso += `\n\n⚠ Hay ${porCobrar.length} cliente(s) por cobrar sin resolver (puedes cerrar igual como administrador).`;
    if (C.diferencia > 0) aviso += `\n\n⚠ Hay un FALTANTE de dinero de ${fmt(C.diferencia)}. Queda como pendiente de otros turnos; el administrador decide si lo descuenta.`;
    if (C.diferencia < 0) aviso += `\n\nHay un SOBRANTE de dinero de ${fmt(-C.diferencia)}. Queda a favor en el pendiente de otros turnos.`;
    if (C.faltanteEntregador > 0) aviso += `\n\n⚠ Faltante de mercancía por pérdida del entregador: ${fmt(C.faltanteEntregador)} (se descuenta de su pago).`;
    const falt = [];
    const nFiado = C.porFactura.filter((pf) => pf.fiado > 0 && !facturas.find((f) => f.id === pf.id)?.foto).length;
    const nTransf = pagos.filter((p) => num(p.transferencia) > 0 && !p.foto).length;
    const nAbono = cobros.filter((c) => !c.foto).length;
    const nConsig = entregas.filter((e) => e.tipo === "consignacion" && !e.comprobante).length;
    const nAjuste = ajustes.filter((a) => ["devolucion", "faltante"].includes(a.tipo) && !a.foto).length;
    const nGasto = gastos.filter((g) => !g.foto).length;
    if (nFiado) falt.push(`${nFiado} fiado(s) sin factura firmada`);
    if (nTransf) falt.push(`${nTransf} transferencia(s) sin comprobante`);
    if (nAbono) falt.push(`${nAbono} abono(s) sin recibo`);
    if (nConsig) falt.push(`${nConsig} consignación(es) sin comprobante`);
    if (nAjuste) falt.push(`${nAjuste} devolución(es)/faltante(s) sin foto`);
    if (nGasto) falt.push(`${nGasto} gasto(s) sin tiquete`);
    if (falt.length) aviso += `\n\n📷 Sin foto (opcional): ${falt.join(", ")}.`;
    if (!confirm(aviso)) return;
    await Q(sb.rpc("guardar_ruta", { p_ruta: id }));
    toast("Ruta guardada");
    recargar();
  };
  H.borrarRuta = async () => {
    if (!confirm("¿Borrar esta ruta y todo lo que tiene anotado?")) return;
    await Q(sb.from("rutas").delete().eq("id", id));
    toast("Ruta borrada");
    volver();
  };
  H.reabrir = () => formModal({
    title: "Reabrir ruta", intro: "Se borran las comisiones y los fiados calculados. Al volver a guardar se recalculan. Queda registrado en la auditoría.",
    fields: [{ id: "motivo", label: "Motivo", type: "text", required: true }],
    ok: "Reabrir",
    onSubmit: async (v) => { await Q(sb.rpc("reabrir_ruta", { p_ruta: id, p_motivo: v.motivo })); recargar(); },
  });
}

/* ------------------------------------------------------------------ */
/* Saldo, comisiones y ganancias                                       */
/* ------------------------------------------------------------------ */
const SALDO = { rango: "30", desde: "", hasta: "" };
// Rango de fechas del filtro de ganancias: [desde, hasta] (null = sin límite).
function rangoFechas(r) {
  const hoy = hoyBogota();
  if (r === "todo") return [null, null];
  if (r === "hoy") return [hoy, hoy];
  if (r === "ayer") { const a = sumarDias(hoy, -1); return [a, a]; }
  if (r === "mes") return [hoy.slice(0, 8) + "01", null];
  if (r === "custom") return [SALDO.desde || null, SALDO.hasta || null];
  return [sumarDias(hoy, -(Number(r) - 1)), null];
}
async function vistaSaldo(empId, propio, volver = null) {
  const esAdmin = S.me.rol === "admin";
  const emp = S.dir.find((d) => d.id === empId) || { nombre: "—", rol: "" };
  const tok = view(propio ? "Mi saldo" : emp.nombre, volver);
  const r = SALDO.rango;
  const [desde, hasta] = rangoFechas(r);
  let ql = sb.from("libro").select("*").eq("empleado_id", empId)
    .order("fecha", { ascending: false }).order("creado_en", { ascending: false }).limit(500);
  if (desde) ql = ql.gte("fecha", desde);
  if (hasta) ql = ql.lte("fecha", hasta);
  let qp = sb.from("pendientes_turno").select("*").eq("empleado_id", empId)
    .order("fecha", { ascending: false }).order("creado_en", { ascending: false }).limit(500);
  if (desde) qp = qp.gte("fecha", desde);
  if (hasta) qp = qp.lte("fecha", hasta);
  const [saldoRaw, lineas, perfil, pendRaw, hist] = await Promise.all([
    Q(sb.rpc("saldo_de", { p_emp: empId })),
    Q(ql),
    esAdmin && !propio ? Q(sb.rpc("resumen_empleados")).then((rows) => rows.find((x) => x.id === empId)) : Promise.resolve(null),
    Q(sb.rpc("pendiente_de", { p_emp: empId })),
    Q(qp),
  ]);
  if (tok !== renderId) return;
  const saldo = num(saldoRaw);
  const pend = num(pendRaw);                       // <0 faltantes por saldar · >0 a favor
  const sugerido = pend < 0 ? Math.min(-pend, Math.max(saldo, 0)) : 0;
  const HIST = {
    faltante: ["Faltante de dinero", "−", "red"], sobrante: ["Sobrante de dinero", "+", "grn"],
    descuento: ["Descontado del saldo", "+", ""], perdon: ["Perdonado", "+", ""],
  };
  const G = resumenGanancias(lineas);
  const rangos = [["hoy", "Hoy"], ["ayer", "Ayer"], ["7", "Últimos 7 días"], ["30", "Últimos 30 días"], ["mes", "Este mes"], ["90", "Últimos 3 meses"]];
  if (esAdmin) rangos.push(["todo", "Todo"]);
  rangos.push(["custom", "Elegir fechas…"]);
  const textoLinea = (l) => {
    if (l.tipo === "comision" && l.manual) return `Ajuste manual · venta ${fmt(l.base)} (${num(l.pct)}%)${l.nota ? " · " + esc(l.nota) : ""}`;
    if (l.tipo === "comision") return `Comisión ${num(l.pct)}% sobre ${fmt(l.base)}`;
    if (l.tipo === "pago") return `Pago recibido${l.nota ? " · " + esc(l.nota) : ""}`;
    return esc(l.nota || "Descuento");
  };

  $app.innerHTML = `
    ${!propio && perfil ? `<div class="mut" style="margin:0 4px 8px">@${esc(perfil.usuario)} · ${ROL[perfil.rol]} · comisión ${num(perfil.pct_comision)}%
      ${perfil.bloqueado ? ` <span class="chip warn">bloqueado</span>` : ""}${!perfil.activo ? ` <span class="chip warn">inactivo</span>` : ""}</div>
      ${perfil.rol === "vendedor" ? `<div class="mut" style="margin:0 4px 8px">Entregador que lleva sus ventas: <b>${esc(S.dir.find((d) => d.id === perfil.entregador_id)?.nombre || "sin asignar")}</b></div>` : ""}` : ""}
    ${propio && S.me.rol === "vendedor" ? `<div class="mut" style="margin:0 4px 8px">Tu entregador: <b>${esc(nombreEntregadorDe(S.me.id))}</b>. Tu comisión se mide sobre la venta real de su ruta.</div>` : ""}
    <div class="grid2">
      <div class="card"><div class="mut">Mi saldo (lo que se le debe pagar)</div>
        <div class="big ${saldo < 0 ? "red" : ""}">${fmt(saldo)}</div>
        ${saldo < 0 ? `<div class="mut">Es negativo: los descuentos superan las comisiones. Se arrastra a los próximos cierres.</div>` : ""}</div>
      <div class="card"><div class="mut">Saldo pendiente de otros turnos</div>
        <div class="big ${pend < 0 ? "red" : pend > 0 ? "grn" : ""}">${pend > 0 ? "+" : ""}${fmt(pend)}</div>
        ${pend < 0 ? `<div class="mut" style="font-size:.75rem">Sugerido descontar de la comisión: <b>${fmt(sugerido)}</b>${sugerido < -pend ? ` · el resto (${fmt(-pend - sugerido)}) queda pendiente` : ""}</div>`
          : pend > 0 ? `<div class="mut" style="font-size:.75rem">A favor: compensa faltantes de otros turnos.</div>`
          : `<div class="mut" style="font-size:.75rem">Sin faltantes pendientes.</div>`}</div>
    </div>
    ${esAdmin && !propio && pend < 0 ? `<div class="grid2">
      <button class="btn" data-a="descontar">Descontar</button>
      <button class="btn sec" data-a="perdonar">Perdonar</button>
    </div>` : ""}
    <select data-c="rango">${rangos.map(([v, l]) => `<option value="${v}"${v === r ? " selected" : ""}>${l}</option>`).join("")}</select>
    ${r === "custom" ? `<div class="grid2"><label class="mut">Desde<input type="date" data-c="desde" value="${esc(SALDO.desde)}"></label>
      <label class="mut">Hasta<input type="date" data-c="hasta" value="${esc(SALDO.hasta)}"></label></div>` : ""}
    <div class="grid2">
      <div class="card"><div class="mut">Promedio diario (neto)</div><div class="big">${fmt(G.promedioDiario)}</div><div class="mut">en ${G.diasTrabajados} días con ruta</div></div>
      <div class="card"><div class="mut">Ganado en el período</div><div class="big">${fmt(G.neto)}</div>
        <div class="mut">${fmt(G.comisiones)} comisiones${G.descuentos ? ` − ${fmt(G.descuentos)} descuentos` : ""}</div></div>
    </div>
    ${esAdmin && !propio ? `<div class="grid2">
      <button class="btn" data-a="manual">+ Venta manual</button>
      ${perfil?.rol === "vendedor" && perfil.entregador_id ? `<button class="btn sec" data-a="sync">Sincronizar ventas anteriores</button>` : ""}
      <button class="btn" data-a="pagar">Registrar pago</button>
      <button class="btn sec" data-a="pin">Cambiar PIN</button>
      <button class="btn sec" data-a="pct">Cambiar % comisión</button>
      ${perfil?.rol === "vendedor" ? `<button class="btn sec" data-a="entregador">Cambiar entregador</button>` : ""}
      <button class="btn sec" data-a="${perfil?.bloqueado ? "desbloquear" : "activo"}">${perfil?.bloqueado ? "Desbloquear cuenta" : perfil?.activo ? "Desactivar" : "Activar"}</button>
    </div>` : ""}
    <div class="card" style="margin-top:12px"><b>Movimientos</b>
      ${lineas.length ? lineas.map((l) => `<div class="mov"><div class="row"><span>${textoLinea(l)}</span>
        <b class="${l.tipo === "comision" ? "grn" : "red"}">${l.tipo === "comision" ? "+" : "−"}${fmt(l.monto)}</b></div>
        <div class="mut">${fechaCorta(l.fecha)}${esAdmin && !propio && l.manual ? ` <button class="x" data-a="editManual" data-id="${l.id}" aria-label="Editar">✎</button><button class="x" data-a="delManual" data-id="${l.id}" aria-label="Quitar">✕</button>` : ""}</div></div>`).join("") : `<p class="mut">Sin movimientos en este período.</p>`}</div>
    <div class="card" style="margin-top:12px"><b>Faltantes y sobrantes (otros turnos)</b>
      ${hist.length ? hist.map((h) => { const [t, sg, cl] = HIST[h.tipo] || [h.tipo, "", ""];
        return `<div class="mov"><div class="row"><span>${t}${h.nota && h.tipo !== "faltante" && h.tipo !== "sobrante" ? " · " + esc(h.nota) : ""}</span>
        <b class="${cl}">${sg}${fmt(h.monto)}</b></div><div class="mut">${fechaCorta(h.fecha)}</div></div>`; }).join("")
        : `<p class="mut">Sin faltantes ni sobrantes en este período.</p>`}</div>
    ${!esAdmin ? `<p class="mut">Aquí ves hasta 3 meses atrás. Tu saldo acumulado incluye todo lo que aún no se te ha pagado.</p>` : ""}`;

  HC.rango = (v) => {
    SALDO.rango = v;
    if (v === "custom" && !SALDO.desde) { SALDO.desde = sumarDias(hoyBogota(), -6); SALDO.hasta = hoyBogota(); }
    vistaSaldo(empId, propio, volver);
  };
  HC.desde = (v) => { SALDO.desde = v; vistaSaldo(empId, propio, volver); };
  HC.hasta = (v) => { SALDO.hasta = v; vistaSaldo(empId, propio, volver); };
  const recargar = () => vistaSaldo(empId, propio, volver);
  const pctEmp = num(perfil?.pct_comision);
  const manualForm = (l) => formModal({
    title: l ? `Editar venta manual · ${emp.nombre}` : `Venta manual · ${emp.nombre}`,
    intro: `Se aplica solo a ${esc(emp.nombre)} con su ${pctEmp}%${l ? ` (la de este ajuste: ${num(l.pct)}%)` : ` (ej. 100.000 → ${esc(fmt(Math.round(100000 * pctEmp / 100)))})`}. Suma a su comisión, no a su total de ventas.`,
    fields: [
      { id: "venta", label: "Valor de la venta", type: "number", value: l?.base ?? "", required: true },
      { id: "fecha", label: "Fecha", type: "date", value: l?.fecha ?? hoyBogota(), required: true },
      { id: "nota", label: "Nota", type: "text", value: l?.nota ?? "", placeholder: "Ej. entrega pedido Don Pedro" },
    ],
    ok: l ? "Guardar cambios" : "Agregar",
    onSubmit: async (v) => {
      if (!(v.venta > 0)) throw new Error("La venta debe ser mayor a 0");
      const m = l
        ? await Q(sb.rpc("ajuste_manual_editar", { p_id: l.id, p_venta: v.venta, p_fecha: v.fecha, p_nota: v.nota || null }))
        : await Q(sb.rpc("ajuste_manual_crear", { p_emp: empId, p_venta: v.venta, p_fecha: v.fecha, p_nota: v.nota || null }));
      toast(`Comisión de ${fmt(m)} ${l ? "actualizada" : "agregada"}`);
      recargar();
    },
  });
  H.manual = () => manualForm(null);
  H.editManual = (d) => manualForm(lineas.find((x) => x.id === d.id));
  H.delManual = async (d) => {
    if (!confirm("¿Quitar esta venta manual?")) return;
    await Q(sb.rpc("ajuste_manual_borrar", { p_id: d.id }));
    toast("Venta manual quitada");
    recargar();
  };
  H.sync = () => formModal({
    title: `Sincronizar ventas anteriores · ${emp.nombre}`,
    intro: `Le da su ${pctEmp}% sobre la venta real de las rutas ya cerradas de ${esc(nombreDe(perfil?.entregador_id))}. No duplica las que ya tiene. Antes de aplicar verás un resumen.`,
    fields: [{ id: "desde", label: "¿Desde qué fecha se sincroniza?", type: "date", value: sumarDias(hoyBogota(), -30), required: true }],
    ok: "Ver resumen",
    onSubmit: async (v) => {
      const p = await Q(sb.rpc("sincronizar_vendedor", { p_vend: empId, p_desde: v.desde, p_aplicar: false }));
      if (!p.rutas) { toast("No hay rutas por sincronizar desde esa fecha"); return; }
      if (!confirm(`Se sincronizarán ${p.rutas} ruta(s) desde ${fechaCorta(v.desde)}.\nComisión total para ${emp.nombre}: ${fmt(p.comision)}.\n\n¿Aplicar?`)) return;
      await Q(sb.rpc("sincronizar_vendedor", { p_vend: empId, p_desde: v.desde, p_aplicar: true }));
      toast(`Sincronizado: ${p.rutas} ruta(s), ${fmt(p.comision)}`);
      recargar();
    },
  });
  H.pagar = () => formModal({
    title: `Pago a ${emp.nombre}`, intro: `Saldo actual: ${esc(fmt(saldo))}. Al pagar todo, el saldo vuelve a 0.`,
    fields: [
      { id: "monto", label: "Valor pagado", type: "number", value: saldo > 0 ? saldo : "", required: true },
      { id: "nota", label: "Nota (opcional)", type: "text", placeholder: "Ej. pago quincena" },
    ],
    ok: "Registrar pago",
    onSubmit: async (v) => {
      if (!(v.monto > 0) || v.monto > saldo) throw new Error("El pago debe ser mayor a 0 y no superar el saldo");
      const resto = await Q(sb.rpc("registrar_pago", { p_emp: empId, p_monto: v.monto, p_nota: v.nota || null }));
      toast(`Pago registrado. Saldo: ${fmt(resto)}`);
      recargar();
    },
  });
  const resolver = (accion) => {
    const descontar = accion === "descontar";
    const tope = descontar ? sugerido : -pend;
    if (!(tope > 0)) { toast("No hay saldo disponible para descontar"); return; }
    formModal({
      title: `${descontar ? "Descontar" : "Perdonar"} faltantes · ${emp.nombre}`,
      intro: descontar
        ? `Pendiente: ${esc(fmt(-pend))}. Se resta de su saldo (${esc(fmt(saldo))}) sin dejarlo negativo; lo que no cabe queda pendiente.`
        : `Pendiente: ${esc(fmt(-pend))}. Se anula sin tocar su saldo.`,
      fields: [{ id: "monto", label: "Valor", type: "number", value: tope, required: true }],
      ok: descontar ? "Descontar" : "Perdonar",
      onSubmit: async (v) => {
        if (!(v.monto > 0) || v.monto > tope) throw new Error(`El valor debe ser mayor a 0 y no superar ${fmt(tope)}`);
        await Q(sb.rpc("resolver_pendiente", { p_emp: empId, p_accion: accion, p_monto: v.monto }));
        toast(descontar ? "Descontado del saldo" : "Faltante perdonado");
        recargar();
      },
    });
  };
  H.descontar = () => resolver("descontar");
  H.perdonar = () => resolver("perdonar");
  H.pin = () => formModal({
    title: `Nuevo PIN · ${emp.nombre}`, intro: "También desbloquea la cuenta si estaba bloqueada.",
    fields: [{ id: "pin", label: "PIN nuevo (4 a 8 dígitos)", type: "pin", required: true }],
    onSubmit: async (v) => { await llamarFn({ accion: "cambiar_pin", usuario_id: empId, pin: v.pin }); toast("PIN cambiado"); recargar(); },
  });
  H.pct = () => formModal({
    title: `Comisión de ${emp.nombre}`, intro: "El cambio aplica a las rutas que se guarden desde ahora. Lo ya guardado no cambia.",
    fields: [{ id: "pct", label: "Porcentaje", type: "number", step: 0.01, value: num(perfil?.pct_comision), required: true }],
    onSubmit: async (v) => {
      if (v.pct < 0 || v.pct > 100) throw new Error("El porcentaje debe estar entre 0 y 100");
      await Q(sb.rpc("admin_actualizar_perfil", { p_id: empId, p_pct: v.pct, p_activo: null }));
      await cargarBase(); recargar();
    },
  });
  H.entregador = () => formModal({
    title: `Entregador de ${emp.nombre}`, intro: "El vendedor ve solo las rutas de su entregador y gana su % sobre la venta real de esa ruta. Aplica a las rutas que se guarden desde ahora.",
    fields: [{ id: "ent", label: "Entregador", type: "select", value: perfil?.entregador_id ?? "",
      options: [{ v: "", l: "Sin entregador" }, ...entregadoresLibres(empId).map((d) => ({ v: d.id, l: d.nombre }))] }],
    onSubmit: async (v) => {
      await Q(sb.rpc("admin_asignar_entregador", { p_vendedor: empId, p_entregador: v.ent || null }));
      await cargarBase(); toast(v.ent ? "Entregador actualizado. Si tiene ventas anteriores, usa «Sincronizar ventas anteriores»." : "Entregador actualizado"); recargar();
    },
  });
  H.desbloquear = async () => { await Q(sb.rpc("admin_desbloquear", { p_id: empId })); toast("Cuenta desbloqueada"); recargar(); };
  H.activo = async () => {
    const nuevo = !perfil.activo;
    if (!confirm(nuevo ? "¿Activar esta cuenta?" : "¿Desactivar? No podrá entrar ni registrar nada, pero su historial se conserva.")) return;
    await Q(sb.rpc("admin_actualizar_perfil", { p_id: empId, p_pct: null, p_activo: nuevo }));
    await cargarBase(); recargar();
  };
}

/* ------------------------------------------------------------------ */
/* Equipo (admin)                                                      */
/* ------------------------------------------------------------------ */
const nombreEntregadorDe = (vendedorId) => {
  const eid = S.dir.find((d) => d.id === vendedorId)?.entregador_id;
  return S.dir.find((d) => d.id === eid)?.nombre || "sin asignar";
};

// Entregadores activos que todavía no tienen vendedor (o el que ya tiene este vendedor).
function entregadoresLibres(vendedorId) {
  return S.dir.filter((d) => d.rol === "entregador" && d.activo &&
    !S.dir.some((x) => x.rol === "vendedor" && x.entregador_id === d.id && x.id !== vendedorId));
}

async function vistaEquipo() {
  const tok = view("Equipo");
  const lista = await Q(sb.rpc("resumen_empleados"));
  if (tok !== renderId) return;
  const porPagar = lista.filter((e) => num(e.saldo) > 0).reduce((s, e) => s + num(e.saldo), 0);
  const sinEnt = lista.filter((e) => e.rol === "vendedor" && e.activo && !e.entregador_id);
  $app.innerHTML = `
    <div class="card"><div class="mut">Total por pagar al equipo</div><div class="big">${fmt(porPagar)}</div></div>
    ${sinEnt.length ? `<div class="msg err">⚠ ${esc(sinEnt.map((e) => e.nombre).join(", "))} no tiene entregador asignado: no gana comisión de las rutas nuevas. Ábrelo y toca «Cambiar entregador».</div>` : ""}
    <button class="btn" data-a="nuevo">+ Nuevo vendedor o entregador</button><div style="height:12px"></div>
    ${lista.length ? lista.map((e) => `<div class="card emp" data-a="ver" data-id="${e.id}">
      <div class="row"><b>${esc(e.nombre)}</b><b class="${num(e.saldo) < 0 ? "red" : ""}">${fmt(e.saldo)}</b></div>
      <div class="mut">${ROL[e.rol]} · @${esc(e.usuario)} · ${num(e.pct_comision)}%${e.rol === "vendedor" ? ` · entrega: ${esc(S.dir.find((d) => d.id === e.entregador_id)?.nombre || "sin entregador")}` : e.rol === "entregador" ? ` · vendedor: ${esc(lista.find((x) => x.rol === "vendedor" && x.entregador_id === e.id)?.nombre || "sin vendedor")}` : ""}
        ${e.bloqueado ? ` <span class="chip warn">bloqueado</span>` : ""}${!e.activo ? ` <span class="chip warn">inactivo</span>` : ""}</div></div>`).join("")
      : `<div class="card mut">Todavía no hay empleados. Crea tu primer vendedor o entregador.</div>`}`;
  H.ver = (d) => vistaSaldo(d.id, false, () => tab("equipo"));
  H.nuevo = () => formModal({
    title: "Nuevo usuario",
    fields: [
      { id: "nombre", label: "Nombre", type: "text", required: true },
      { id: "usuario", label: "Usuario para entrar (minúsculas, sin espacios)", type: "text", required: true, placeholder: "ej. carlos" },
      { id: "rol", label: "Rol", type: "select", options: [{ v: "entregador", l: "Entregador (4%)" }, { v: "vendedor", l: "Vendedor (3,5%)" }] },
      { id: "entregador", label: "Entregador que entrega las ventas de este vendedor", type: "select", value: "", showIf: (v) => v.rol === "vendedor",
        options: [{ v: "", l: "Escoge el entregador…" }, ...entregadoresLibres(null).map((d) => ({ v: d.id, l: d.nombre }))] },
      { id: "pin", label: "PIN de 4 dígitos", type: "pin", required: true },
      { id: "pct", label: "% de comisión (vacío = 4% entregador, 3,5% vendedor)", type: "number", step: 0.01 },
    ],
    onSubmit: async (v) => {
      if (v.rol === "vendedor" && !v.entregador) throw new Error("Escoge el entregador de este vendedor (primero crea al entregador si aún no existe)");
      const nuevo = await llamarFn({ accion: "crear", nombre: v.nombre, usuario: v.usuario.toLowerCase(), rol: v.rol, pin: v.pin, pct_comision: v.pct });
      if (v.rol === "vendedor") {
        try { await Q(sb.rpc("admin_asignar_entregador", { p_vendedor: nuevo.id, p_entregador: v.entregador })); }
        catch (e) { await cargarBase(); vistaEquipo(); throw new Error("El usuario se creó, pero no se pudo atar al entregador: " + e.message + ". Hazlo desde su ficha."); }
      }
      await cargarBase();
      toast("Usuario creado");
      vistaEquipo();
    },
  });
}

/* ------------------------------------------------------------------ */
/* Más: cuentas, clientes, auditoría, PIN propio (admin)               */
/* ------------------------------------------------------------------ */
async function vistaMas() {
  view("Más");
  $app.innerHTML = `
    <div class="card emp" data-a="clientes"><b>🧑‍🤝‍🧑 Clientes</b><div class="mut">Plazo de fiado y teléfono de cada cliente</div></div>
    <div class="card emp" data-a="audit"><b>📋 Auditoría</b><div class="mut">Quién guardó, reabrió o pagó y cuándo</div></div>
    <div class="card emp" data-a="mipin"><b>🔑 Cambiar mi PIN</b></div>`;
  H.clientes = vistaClientes; H.audit = vistaAuditoria;
  H.mipin = () => formModal({
    title: "Cambiar mi PIN", intro: "Para el administrador recomiendo 6 a 8 dígitos.",
    fields: [{ id: "pin", label: "PIN nuevo (4 a 8 dígitos)", type: "pin", required: true }],
    onSubmit: async (v) => { await llamarFn({ accion: "cambiar_pin", usuario_id: S.me.id, pin: v.pin }); toast("PIN cambiado"); },
  });
}

async function vistaClientes() {
  const tok = view("Clientes", () => tab("mas"));
  await cargarBase();
  if (tok !== renderId) return;
  const pintar = (txt = "") => {
    const t = txt.trim().toLowerCase();
    const lista = S.clientes.filter((c) => !t || c.nombre.toLowerCase().includes(t));
    document.getElementById("lista").innerHTML = lista.length ? lista.slice(0, 200).map((c) => `<div class="card emp" data-a="editar" data-id="${c.id}">
      <div class="row"><b>${esc(c.nombre)}</b><span class="chip">${c.plazo_dias} días</span></div>
      <div class="mut">${esc(c.telefono || "sin teléfono")}${c.activo ? "" : " · inactivo"}</div></div>`).join("") : `<div class="card mut">Sin resultados.</div>`;
  };
  $app.innerHTML = `<button class="btn" data-a="nuevo">+ Nuevo cliente</button><div style="height:12px"></div>
    <input data-i="buscar" placeholder="Buscar cliente…"><div id="lista"></div>`;
  pintar();
  HI.buscar = (v) => pintar(v);
  const form = (c) => formModal({
    title: c ? "Editar cliente" : "Nuevo cliente",
    fields: [
      { id: "nombre", label: "Nombre", type: "text", value: c?.nombre ?? "", required: true },
      { id: "telefono", label: "Teléfono", type: "text", value: c?.telefono ?? "" },
      { id: "plazo", label: "Días para pagar el fiado", type: "number", value: c?.plazo_dias ?? 7, required: true },
      { id: "activo", label: "Estado", type: "select", value: c?.activo === false ? "no" : "si", options: [{ v: "si", l: "Activo" }, { v: "no", l: "Inactivo" }] },
    ],
    onSubmit: async (v) => {
      const datos = { nombre: v.nombre, telefono: v.telefono || null, plazo_dias: v.plazo, activo: v.activo === "si" };
      if (c) await Q(sb.from("clientes").update(datos).eq("id", c.id)); else await Q(sb.from("clientes").insert(datos));
      vistaClientes();
    },
  });
  H.nuevo = () => form(null);
  H.editar = (d) => form(S.clientes.find((c) => c.id === d.id));
}

async function vistaAuditoria() {
  const tok = view("Auditoría", () => tab("mas"));
  const filas = await Q(sb.from("auditoria").select("*").order("id", { ascending: false }).limit(60));
  if (tok !== renderId) return;
  const ETQ = { guardar_ruta: "Guardó una ruta", reabrir_ruta: "Reabrió una ruta", pago: "Registró un pago", crear_usuario: "Creó un usuario",
    cambiar_pin: "Cambió un PIN", desbloquear: "Desbloqueó una cuenta", actualizar_perfil: "Cambió un perfil", posponer_cartera: "Pospuso un cobro",
    bloqueo_por_intentos: "Cuenta bloqueada por intentos", setup_admin: "Creó el administrador" };
  $app.innerHTML = filas.length ? filas.map((a) => `<div class="card"><div class="row"><b>${esc(ETQ[a.accion] || a.accion)}</b><span class="mut">${fechaHora(a.fecha)}</span></div>
    <div class="mut">${esc(nombreDe(a.usuario_id))}${a.detalle ? " · " + esc(JSON.stringify(a.detalle)).slice(0, 160) : ""}</div></div>`).join("")
    : `<div class="card mut">Sin registros todavía.</div>`;
}

boot();
