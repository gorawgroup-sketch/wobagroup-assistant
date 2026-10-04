import { Worker } from "node:worker_threads";

// Keep decoding off the bot's event loop. The converter is portable JS/WASM,
// so the deployed Linux service does not depend on macOS or system codecs.
const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const convert = require(workerData.converter);
  const images = await convert.all({ buffer: Buffer.from(workerData.bytes), format: 'JPEG', quality: 0.85 });
  if (!images.length || images.length > 10) throw new Error('El HEIC debe contener entre 1 y 10 imágenes.');
  const output = [];
  let total = 0;
  for (const image of images) {
    const bytes = Buffer.from(await image.convert());
    if (bytes.length > 4.5 * 1024 * 1024) throw new Error('Una imagen del HEIC supera el tamaño de lectura; envía una copia reducida o PDF.');
    total += bytes.length;
    if (total > 20 * 1024 * 1024) throw new Error('El HEIC contiene demasiadas imágenes para una sola lectura; divide el documento.');
    output.push(bytes);
  }
  parentPort.postMessage({ images: output });
})().catch(error => parentPort.postMessage({ error: String(error.message || error) }));
`;

/** Converts every image, without writing to or replacing the original file. */
export async function convertirHeicAJpeg(data: Buffer): Promise<Buffer[]> {
  if (!data.length || data.length > 20 * 1024 * 1024) {
    throw new Error("El archivo HEIC está vacío o supera 20 MB; envía una copia más pequeña o PDF.");
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_CODE, {
      eval: true,
      workerData: { bytes: data, converter: require.resolve("heic-convert") },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let finished = false;
    const finish = (error?: Error, images?: Buffer[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(images!);
    };
    const timer = setTimeout(() => finish(new Error("La conversión del HEIC excedió 30 segundos; prueba con una copia JPEG o PDF.")), 30_000);
    worker.once("message", (result: { error?: string; images?: Uint8Array[] }) => {
      if (result.error || !result.images?.length) {
        finish(new Error(`No se pudo convertir el archivo HEIC: ${result.error || "sin imágenes"}`));
      } else {
        finish(undefined, result.images.map((image) => Buffer.from(image)));
      }
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (!finished) finish(new Error(`La conversión HEIC terminó sin imágenes (código ${code}).`));
    });
  });
}
