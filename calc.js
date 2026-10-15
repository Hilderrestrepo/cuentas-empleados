// Cálculos del cierre de ruta (vista previa en pantalla).
// La base de datos (guardar_ruta) repite estas mismas cuentas al guardar y es la que manda.

export const num = (v) => Number(v) || 0;
export const sum = (arr, f = (x) => x) => arr.reduce((s, x) => s + num(f(x)), 0);

/**
 * facturas: {id, valor, vendedor_id}
 * ajustes:  {factura_id|null, tipo, responsable, monto}   (restan de la venta real; sin factura_id = devolución suelta)
 * pagos:    {factura_id, efectivo, transferencia}     (lo cobrado al entregar)
 * cobros:   {tipo: 'efectivo'|'transferencia', monto} (fiados viejos cobrados hoy)
 * entregas: {monto}  gastos: {monto}
 * base: efectivo con el que sale el entregador (se suma a lo que debe entregar)
 * cargue: valor total del cargue (solo para avisar si las facturas no suman lo mismo)
 */
export function calcRuta({ facturas = [], ajustes = [], pagos = [], cobros = [], entregas = [], gastos = [], base = 0, cargue = null }) {
  const pagoDe = new Map(pagos.map((p) => [p.factura_id, p]));
  const porFactura = facturas.map((f) => {
    const aj = sum(ajustes.filter((a) => a.factura_id === f.id), (a) => a.monto);
    const p = pagoDe.get(f.id) || {};
    const ef = num(p.efectivo);
    const tr = num(p.transferencia);
    const valor = num(f.valor);
    const real = valor - aj;
    const fiado = real - ef - tr;
    let error = null;
    if (aj > valor) error = "Los descuentos superan el valor de la factura";
    else if (fiado < 0) error = "Lo cobrado supera la venta real de esta factura";
    return { id: f.id, vendedor_id: f.vendedor_id, valor, aj, ef, tr, real, fiado, error };
  });

  const salida = sum(porFactura, (x) => x.valor);
  // Devoluciones sueltas (solo número de factura del POS): restan del cargue.
  const descSueltos = sum(ajustes.filter((a) => !a.factura_id), (a) => a.monto);
  const descuentos = sum(porFactura, (x) => x.aj) + descSueltos;
  const hayCargue = !(cargue === null || cargue === undefined || cargue === "");
  const salidaTotal = hayCargue ? Math.max(num(cargue), salida) : salida; // con cargue, la salida es el cargue
  const real = salidaTotal - descuentos;
  const efectivoFact = sum(porFactura, (x) => x.ef);
  const transfFact = sum(porFactura, (x) => x.tr);
  const fiadoNuevo = sum(porFactura, (x) => Math.max(x.fiado, 0));
  const cobrosEf = sum(cobros.filter((c) => c.tipo === "efectivo"), (c) => c.monto);
  const cobrosTr = sum(cobros.filter((c) => c.tipo === "transferencia"), (c) => c.monto);
  const gastosTotal = sum(gastos, (g) => g.monto);
  const entregado = sum(entregas, (e) => e.monto);
  const baseRuta = num(base);
  // Si hay cargue, lo que no se anotó en facturas se supone cobrado en efectivo.
  const sinFacturas = hayCargue ? Math.max(num(cargue) - salida - descSueltos, 0) : 0;
  const esperado = efectivoFact + sinFacturas + cobrosEf - gastosTotal + baseRuta; // lo que debe entregar (la base se devuelve)
  const difCargue = cargue === null || cargue === undefined || cargue === "" ? null : salida - num(cargue); // <0 faltan facturas por anotar
  const diferencia = esperado - entregado;                // >0 falta dinero, <0 sobra
  const faltanteEntregador = sum(
    ajustes.filter((a) => a.tipo === "faltante" && a.responsable === "entregador"),
    (a) => a.monto,
  );
  return {
    porFactura, salida, salidaTotal, hayCargue, descSueltos, descuentos, real, efectivoFact, transfFact, fiadoNuevo,
    cobrosEf, cobrosTr, gastos: gastosTotal, base: baseRuta, difCargue, sinFacturas, esperado, entregado, diferencia,
    faltanteEntregador, errores: porFactura.filter((x) => x.error),
  };
}

/** Comisiones: entregador % de la venta real de la ruta; vendedor % de la venta real de SUS facturas. */
export function comisiones(C, pctEntregador, pctPorVendedor = {}) {
  const entregador = Math.round((C.real * num(pctEntregador)) / 100);
  const base = {};
  for (const f of C.porFactura) base[f.vendedor_id] = (base[f.vendedor_id] || 0) + f.real;
  const vendedores = Object.entries(base).map(([id, b]) => ({
    id, base: b, monto: Math.round((b * num(pctPorVendedor[id])) / 100),
  }));
  return { entregador, vendedores };
}

/** Ganancias a partir de las líneas del libro (comision, desc_*, pago). */
export function resumenGanancias(lineas) {
  let comisionesT = 0, descuentos = 0, pagos = 0;
  const dias = new Set();
  for (const l of lineas) {
    const m = num(l.monto);
    if (l.tipo === "pago") { pagos += m; continue; }
    dias.add(l.fecha);
    if (l.tipo === "comision") comisionesT += m;
    else descuentos += m;
  }
  const neto = comisionesT - descuentos;
  return {
    comisiones: comisionesT, descuentos, pagos, neto,
    diasTrabajados: dias.size,
    promedioDiario: dias.size ? Math.round(neto / dias.size) : 0,
  };
}

/** Estado de un fiado según los días de atraso (positivo = vencido). */
export function estadoCartera(diasAtraso) {
  if (diasAtraso > 0) return { clave: "vencida", texto: `${diasAtraso} ${diasAtraso === 1 ? "día" : "días"} de atraso`, cls: "red" };
  if (diasAtraso === 0) return { clave: "hoy", texto: "vence hoy", cls: "red" };
  return { clave: "proxima", texto: `vence en ${-diasAtraso} ${diasAtraso === -1 ? "día" : "días"}`, cls: "mut" };
}
