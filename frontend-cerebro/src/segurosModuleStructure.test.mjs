import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appPath = fileURLToPath(new URL("./App.jsx", import.meta.url));
const modulePath = fileURLToPath(new URL("./modules/Seguros.jsx", import.meta.url));

test("Seguros vive en un módulo propio y App solo lo monta", async () => {
  const [app, seguros] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(modulePath, "utf8"),
  ]);

  assert.match(app, /import SegurosContenido from "\.\/modules\/Seguros\.jsx"/);
  assert.doesNotMatch(app, /function SegurosContenido/);
  assert.match(seguros, /confirmandoId/);
  assert.match(seguros, /X-Cerebro-Key/);
});
