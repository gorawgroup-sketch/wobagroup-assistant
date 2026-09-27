export type EstadoPoliza = "vigente" | "vencida" | "no_contratada" | "pendiente_confirmacion";
export type EstadoPago = "pagado" | "pendiente" | "sin_confirmar" | "no_aplica";

/**
 * Ver docs/wobi-seguros.md §5 — modelo de datos propuesto. `empresa` es
 * texto libre, no atado al union type `Empresa` de core/holded/client.ts
 * (§7 del diseño), para poder trackear pólizas de una empresa nueva antes
 * de que tenga integración Holded.
 */
export interface Poliza {
  id: string;
  empresa: string;
  empresaHolded: string;
  aseguradora: string;
  correduria: string;
  numeroPoliza: string;
  tipoCobertura: string;
  activoAsociado: string;
  capitalAsegurado: string;
  moneda: string;
  franquicia: string;
  prima: string;
  periodicidad: string;
  cuentaDeCargo: string;
  fechaInicioVigencia: string;
  fechaVencimiento: string;
  estado: EstadoPoliza;
  estadoPago: EstadoPago;
  fuenteExtraccion: string;
  notas: string;
  rutaDocumento: string;
  ultimaVerificacion: string;
}
