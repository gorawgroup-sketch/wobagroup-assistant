import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildAuditRecord,
  listEligibleFiles,
  sanitizeStructuredResult,
  selectReviewFiles,
  selectRotatingFiles,
} from "./shadow-review.mjs";

test("selecciona como máximo tres TypeScript seguros y excluye archivos largos", () => {
  const root = mkdtempSync(join(tmpdir(), "wobi-claude-max-"));
  const safe = join(root, "core", "utils");
  mkdirSync(safe, { recursive: true });
  for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"]) writeFileSync(join(safe, name), "export {};\n");
  writeFileSync(join(safe, "demasiado-largo.ts"), `${"x\n".repeat(400)}x`);
  writeFileSync(join(safe, "ignorar.js"), "export {};\n");

  const eligible = listEligibleFiles(root);
  const selected = selectReviewFiles(root, new Date("2026-09-08T12:00:00Z"));
  assert.equal(eligible.includes("core/utils/demasiado-largo.ts"), false);
  assert.equal(selected.length > 0 && selected.length <= 3, true);
  assert.equal(new Set(selected).size, selected.length);
  assert.equal(selected.every((file) => eligible.includes(file)), true);
});

test("la rotación es determinista para la misma fecha", () => {
  const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
  const expected = ["c.ts", "d.ts", "e.ts"];
  assert.deepEqual(selectRotatingFiles(files, new Date("2026-09-08T01:00:00Z")), expected);
  assert.deepEqual(selectRotatingFiles(files, new Date("2026-09-08T23:00:00Z")), expected);
});

test("rechaza hallazgos sobre archivos no seleccionados", () => {
  assert.throws(
    () =>
      sanitizeStructuredResult(
        {
          status: "finding",
          reviewed_files: ["core/utils/a.ts"],
          findings: [
            {
              file: ".env",
              line: 1,
              summary: "No debe pasar",
              diagnosis: "Fuera de alcance",
              confidence: 1,
            },
          ],
        },
        ["core/utils/a.ts"]
      ),
    /selección segura/
  );
});

test("crea un registro auditable sin copiar el log completo", () => {
  const root = mkdtempSync(join(tmpdir(), "wobi-claude-usage-"));
  const execution = join(root, "execution.json");
  writeFileSync(
    execution,
    JSON.stringify({
      type: "result",
      num_turns: 2,
      total_cost_usd: 0.17,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 },
      modelUsage: { "claude-sonnet": { costUSD: 0.17 } },
      result: "contenido que no debe copiarse",
    })
  );
  const selectedFiles = ["core/utils/a.ts"];
  const record = buildAuditRecord({
    structuredOutput: JSON.stringify({ status: "ok", reviewed_files: selectedFiles, findings: [] }),
    selectedFiles,
    executionFile: execution,
    env: { GITHUB_REPOSITORY: "org/repo", GITHUB_SHA: "abc" },
  });

  assert.equal(record.actual_api_spend_usd, 0);
  assert.equal(record.usage.subscription_equivalent_usd, 0.17);
  assert.equal(record.usage.input_tokens, 100);
  assert.equal(JSON.stringify(record).includes("contenido que no debe copiarse"), false);
});
