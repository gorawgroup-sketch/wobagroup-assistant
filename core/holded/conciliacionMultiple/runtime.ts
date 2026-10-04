import { HoldedConciliacionAdapter } from "./holdedAdapter";
import { storeConciliacionMultiple } from "./store";
import { ServicioConciliacionMultiple } from "./service";
export const conciliacionMultiple = new ServicioConciliacionMultiple(new HoldedConciliacionAdapter(), storeConciliacionMultiple);
