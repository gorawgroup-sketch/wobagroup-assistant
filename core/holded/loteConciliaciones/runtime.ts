import { HoldedConciliacionAdapter } from "../conciliacionMultiple/holdedAdapter";
import { registrarConciliacionVerificada } from "../conciliacionAprendidaSheet";
import { conciliacionMultiple } from "../conciliacionMultiple/runtime";
import { ServicioLoteConciliaciones } from "./service";
import { storeLotesConciliaciones } from "./store";

/** El lote reutiliza el motor de planes ya instanciado: una sola ruta de escritura, un solo conjunto de reservas. */
export const loteConciliaciones = new ServicioLoteConciliaciones(conciliacionMultiple, new HoldedConciliacionAdapter(), storeLotesConciliaciones, Date.now,
  // Cada par que Holded confirmó alimenta la misma memoria que las conciliaciones por botón (⭐ del buscador, coincidencias «aprendidas»).
  async (par, empresa) => registrarConciliacionVerificada({
    empresa, proveedor: par.proveedor, gastoId: par.compraId,
    movimiento: { accountId: par.movimiento.split("/")[0], descripcion: par.descripcion, monto: -par.importeCentimos / 100, moneda: par.moneda, fecha: par.fechaMovimiento, origenCoincidencia: "lote" },
  }));
