/** 'S3', 's03', '3', 'semana 38', 'S-38', 's.38' → 'S03'/'S38'. Lo que no parece una semana se devuelve recortado y en mayúsculas. */
export function normalizarSemana(semana: string): string {
  const m = String(semana ?? "").trim().match(/^(?:semana\s*)?s?[\s.\-]*0*(\d{1,2})$/i);
  return m ? `S${m[1].padStart(2, "0")}` : String(semana ?? "").trim().toUpperCase();
}

export function esSemanaValida(semana: string): boolean {
  return /^S\d{2}$/.test(normalizarSemana(semana));
}
