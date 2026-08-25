/**
 * IDs de las carpetas raíz de Drive por empresa, compartidas entre búsqueda
 * (buscar_documento_drive) y subida (archivado de documentos entrantes).
 */
export const ROOT_FOLDERS: Record<string, string> = {
  WOBA: "1BvNawKKN6BUxStcU8FqXRBLuKmkxa-Q8",
  EWORKS: "1CYMOAUnOJN1eTIlmvNaJVyZ1ujNLB-e8",
  Footprint: "1LYpshXoG8c5cbyv4GpTiVEZBjXxNDtcn",
};

export type EmpresaConCarpeta = keyof typeof ROOT_FOLDERS;
