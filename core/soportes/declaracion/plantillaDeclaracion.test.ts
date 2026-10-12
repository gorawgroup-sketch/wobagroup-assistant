import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { importe, rellenarDocumentoXml, rellenarPlantillaDeclaracion } from "./plantillaDeclaracion";

const celda = (id: string) => `<w:tc><w:tcPr/><w:p w14:paraId="${id}"><w:pPr/><w:r><w:rPr/></w:r></w:p></w:tc>`;
const fila = (n: number) => `<w:tr><w:trPr/>${celda(`a${n}`)}${celda(`b${n}`)}${celda(`c${n}`)}</w:tr>`;
const XML = `<w:document><w:body>
<w:p><w:r><w:t>GASTOS SIN SOPORTE [NOMBRE Y APELLIDOS]</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>FECHA</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>LUGAR</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>VALOR</w:t></w:r></w:p></w:tc></w:tr>${fila(1)}${fila(2)}${fila(3)}</w:tbl>
<w:p><w:r><w:t xml:space="preserve">         TOTAL                0,00€</w:t></w:r></w:p>
<w:p><w:r><w:t>[NOMBRE Y APELLIDOS]</w:t><w:br/><w:t>[CARGO]</w:t><w:br/><w:t>COMPAÑIA DE PROYECTOS EWORKS, SL</w:t></w:r></w:p>
</w:body></w:document>`;

test("caso German: nombre y cargo en título y firma, una fila por cargo (más que las vacías), total sumado y texto escapado", () => {
  const xml = rellenarDocumentoXml(XML, { nombre: "German Alejandro Robles", cargo: "CEO", lineas: [
    { fecha: "2026-09-07", lugar: "Avolta Aams K Comunal 220", valor: 31.25 },
    { fecha: "2026-09-07", lugar: "Airalo", valor: 9 },
    { fecha: "2026-09-08", lugar: "Rosso Brera", valor: 80 },
    { fecha: "2026-09-13", lugar: "Rist Pizz Tovo <Milano> & Co", valor: 47.4 },
  ] });
  assert.equal((xml.match(/German Alejandro Robles/g) ?? []).length, 2);
  assert.match(xml, /<w:t>CEO<\/w:t>|<w:t xml:space="preserve">CEO<\/w:t>|CEO<\/w:t>/);
  assert.equal((xml.match(/<w:tr[ >]/g) ?? []).length, 5); // cabecera + 4
  assert.match(xml, /07\/09\/2026/); assert.match(xml, /Rosso Brera/); assert.match(xml, /80,00€/);
  assert.match(xml, /Rist Pizz Tovo &lt;Milano&gt; &amp; Co/);
  assert.match(xml, /TOTAL\s+167,65€/);
  assert.doesNotMatch(xml, /\[NOMBRE Y APELLIDOS\]|\[CARGO\]|TOTAL\s+0,00€/);
});

test("menos cargos que filas vacías: sobran filas y se quitan; sin cargos no se genera", () => {
  const xml = rellenarDocumentoXml(XML, { nombre: "X", cargo: "Y", lineas: [{ fecha: "2026-10-01", lugar: "Bar", valor: 2.5 }] });
  assert.equal((xml.match(/<w:tr[ >]/g) ?? []).length, 2);
  assert.match(xml, /TOTAL\s+2,50€/);
  assert.throws(() => rellenarDocumentoXml(XML, { nombre: "X", cargo: "Y", lineas: [] }), /al menos un cargo/);
});

test("rellena un docx real (zip) y conserva el resto de partes", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", XML); zip.file("word/styles.xml", "<w:styles/>");
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const salida = await rellenarPlantillaDeclaracion(bytes, { nombre: "Ana", cargo: "CFO", lineas: [{ fecha: "2026-10-02", lugar: "Taxi", valor: 12 }] });
  const z2 = await JSZip.loadAsync(salida);
  assert.match(await z2.file("word/document.xml")!.async("string"), /Ana[\s\S]*Taxi[\s\S]*TOTAL\s+12,00€/);
  assert.ok(z2.file("word/styles.xml"));
  assert.equal(importe(1234.5), "1234,50€".replace("1234", new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2 }).format(1234.5).split(",")[0]));
});
