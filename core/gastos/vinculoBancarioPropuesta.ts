import {
  actualizarMovimientosAmbiguosPropuestaGasto,
  actualizarFlagMovimientoBancarioGasto,
  type PropuestaGasto,
} from './gastoProposalSheet';
import type { MovimientoBancarioCandidato } from '../holded/write';

/** Solo devuelve un estado publicable cuando ambos campos quedaron guardados. */
export async function guardarVinculoBancarioPropuesta(
  propuesta: PropuestaGasto,
  movimientos: MovimientoBancarioCandidato[],
  recomendado: boolean,
  persistir = {
    movimientos: actualizarMovimientosAmbiguosPropuestaGasto,
    flag: actualizarFlagMovimientoBancarioGasto,
  }
): Promise<PropuestaGasto> {
  if (!await persistir.movimientos(propuesta.id, movimientos) ||
      !await persistir.flag(propuesta.id, recomendado)) {
    throw new Error('No se pudo guardar durablemente el movimiento bancario recomendado.');
  }
  return { ...propuesta, movimientosAmbiguos: movimientos, hayMovimientoBancario: recomendado };
}
