import assert from "node:assert/strict";
import test from "node:test";
import { configuracionSubidasDriveDurables } from "./client";

test("el ledger de Drive solo se desactiva con false explícito", () => {
  assert.equal(configuracionSubidasDriveDurables({}).habilitado, true);
  assert.equal(configuracionSubidasDriveDurables({ WOBI_DRIVE_DURABLE_ENABLED: "errata" }).habilitado, true);
  assert.equal(configuracionSubidasDriveDurables({ WOBI_DRIVE_DURABLE_ENABLED: " false " }).habilitado, false);
});
