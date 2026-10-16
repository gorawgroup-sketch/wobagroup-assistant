import { HoldedConciliacionAdapter } from "../conciliacionMultiple/holdedAdapter";
import { conciliacionMultiple } from "../conciliacionMultiple/runtime";
import { ServicioLoteConciliaciones } from "./service";
import { storeLotesConciliaciones } from "./store";

/** El lote reutiliza el motor de planes ya instanciado: una sola ruta de escritura, un solo conjunto de reservas. */
export const loteConciliaciones = new ServicioLoteConciliaciones(conciliacionMultiple, new HoldedConciliacionAdapter(), storeLotesConciliaciones);
