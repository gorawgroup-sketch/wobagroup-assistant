import {
  appendFileSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SAFE_ROOT = "core/utils";
const DEFAULT_MAX_FILES = 3;
const MAX_LINES = 400;
const DAY_MS = 86_400_000;

function isInside(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function walkTypescriptFiles(directory, safeRoot) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (!isInside(safeRoot, absolute)) throw new Error(`Ruta fuera de la lista segura: ${absolute}`);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...walkTypescriptFiles(absolute, safeRoot));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute);
  }
  return files;
}

function listSafeFiles(repoRoot) {
  const absoluteRepo = resolve(repoRoot);
  const absoluteSafeRoot = resolve(absoluteRepo, SAFE_ROOT);
  if (!isInside(absoluteRepo, absoluteSafeRoot) || lstatSync(absoluteSafeRoot).isSymbolicLink()) {
    throw new Error("La raíz segura de autorrevisión no es válida.");
  }

  return walkTypescriptFiles(absoluteSafeRoot, absoluteSafeRoot)
    .map((absolute) => relative(absoluteRepo, absolute).split(sep).join("/"))
    .sort();
}

function isWithinLineLimit(repoRoot, repoRelativePath) {
  const absoluteRepo = resolve(repoRoot);
  const absolute = resolve(absoluteRepo, repoRelativePath);
  if (!isInside(resolve(absoluteRepo, SAFE_ROOT), absolute)) return false;
  return readFileSync(absolute, "utf8").split("\n").length <= MAX_LINES;
}

export function listEligibleFiles(repoRoot) {
  return listSafeFiles(repoRoot).filter((file) => isWithinLineLimit(repoRoot, file));
}

export function selectRotatingFiles(files, date = new Date(), maxFiles = DEFAULT_MAX_FILES) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("No hay archivos seguros elegibles.");
  if (!Number.isInteger(maxFiles) || maxFiles <= 0) throw new Error("maxFiles debe ser un entero positivo.");

  const unique = [...new Set(files)].sort();
  const count = Math.min(maxFiles, unique.length);
  const utcDay = Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / DAY_MS
  );
  const start = (utcDay * count) % unique.length;
  return Array.from({ length: count }, (_, index) => unique[(start + index) % unique.length]);
}

export function selectReviewFiles(repoRoot, date = new Date()) {
  // Primero rota sobre el universo seguro y luego descarta archivos grandes,
  // igual que la ruta API. Así ambos caminos comparan las mismas rutas.
  return selectRotatingFiles(listSafeFiles(repoRoot), date).filter((file) =>
    isWithinLineLimit(repoRoot, file)
  );
}

function parseJsonOrJsonLines(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const records = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (records.length === 0) throw new Error("El archivo de ejecución de Claude está vacío.");
    return records;
  }
}

function findResultRecord(parsed) {
  const records = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.messages)
      ? [...parsed.messages, parsed]
      : [parsed];
  return [...records]
    .reverse()
    .find(
      (record) =>
        record &&
        typeof record === "object" &&
        (record.type === "result" || "total_cost_usd" in record || "usage" in record)
    );
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function extractUsage(executionFile) {
  if (!executionFile) {
    return {
      model_turns: null,
      input_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens: null,
      subscription_equivalent_usd: null,
      models: [],
    };
  }

  const result = findResultRecord(parseJsonOrJsonLines(readFileSync(executionFile, "utf8")));
  const usage = result?.usage && typeof result.usage === "object" ? result.usage : {};
  const modelUsage = result?.modelUsage && typeof result.modelUsage === "object" ? result.modelUsage : {};
  return {
    model_turns: finiteOrNull(result?.num_turns),
    input_tokens: finiteOrNull(usage.input_tokens),
    cache_creation_input_tokens: finiteOrNull(usage.cache_creation_input_tokens),
    cache_read_input_tokens: finiteOrNull(usage.cache_read_input_tokens),
    output_tokens: finiteOrNull(usage.output_tokens),
    subscription_equivalent_usd: finiteOrNull(result?.total_cost_usd),
    models: Object.keys(modelUsage).sort(),
  };
}

function cleanText(value, field, maxLength) {
  if (typeof value !== "string") throw new Error(`${field} debe ser texto.`);
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

export function sanitizeStructuredResult(rawResult, selectedFiles) {
  if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
    throw new Error("La salida estructurada no es un objeto.");
  }
  const allowedStatuses = new Set(["ok", "finding", "incomplete"]);
  if (!allowedStatuses.has(rawResult.status)) throw new Error("Estado de revisión inválido.");

  const selected = new Set(selectedFiles);
  if (!Array.isArray(rawResult.reviewed_files)) throw new Error("Falta reviewed_files.");
  const reviewedFiles = [...new Set(rawResult.reviewed_files)];
  if (reviewedFiles.some((file) => typeof file !== "string" || !selected.has(file))) {
    throw new Error("Claude reportó un archivo fuera de la selección segura.");
  }
  if (rawResult.status !== "incomplete" && reviewedFiles.length !== selected.size) {
    throw new Error("Claude no confirmó la revisión de todos los archivos seleccionados.");
  }

  if (!Array.isArray(rawResult.findings) || rawResult.findings.length > 3) {
    throw new Error("La lista de hallazgos no es válida.");
  }
  const findings = rawResult.findings.map((finding, index) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error(`Hallazgo ${index + 1} inválido.`);
    }
    if (typeof finding.file !== "string" || !selected.has(finding.file)) {
      throw new Error(`Hallazgo ${index + 1} fuera de la selección segura.`);
    }
    if (!Number.isInteger(finding.line) || finding.line < 1) {
      throw new Error(`Línea inválida en el hallazgo ${index + 1}.`);
    }
    if (typeof finding.confidence !== "number" || finding.confidence < 0 || finding.confidence > 1) {
      throw new Error(`Confianza inválida en el hallazgo ${index + 1}.`);
    }
    return {
      file: finding.file,
      line: finding.line,
      summary: cleanText(finding.summary, "summary", 240),
      diagnosis: cleanText(finding.diagnosis, "diagnosis", 1200),
      confidence: finding.confidence,
    };
  });

  if (rawResult.status === "ok" && findings.length !== 0) {
    throw new Error("Una revisión ok no puede contener hallazgos.");
  }
  if (rawResult.status === "finding" && findings.length === 0) {
    throw new Error("Una revisión finding debe contener al menos un hallazgo.");
  }
  return { status: rawResult.status, reviewed_files: reviewedFiles.sort(), findings };
}

export function buildAuditRecord({ structuredOutput, selectedFiles, executionFile, env = process.env }) {
  const parsed = JSON.parse(structuredOutput);
  return {
    schema_version: 1,
    created_at: new Date().toISOString(),
    process: "autorrevision_codigo",
    provider: "claude_code",
    model_requested: "sonnet",
    authentication: "claude_max_oauth",
    billing: "subscription",
    mode: "shadow",
    calls: 1,
    actual_api_spend_usd: 0,
    repository: env.GITHUB_REPOSITORY ?? null,
    commit_sha: env.GITHUB_SHA ?? null,
    workflow_run_id: env.GITHUB_RUN_ID ?? null,
    workflow_run_attempt: env.GITHUB_RUN_ATTEMPT ?? null,
    selected_files: selectedFiles,
    usage: extractUsage(executionFile),
    result: sanitizeStructuredResult(parsed, selectedFiles),
  };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta ${name}.`);
  return value;
}

function runSelect() {
  const selectedFiles = selectReviewFiles(process.cwd());
  if (selectedFiles.length === 0) throw new Error("La rotación no produjo archivos revisables.");
  const json = JSON.stringify(selectedFiles);
  const githubOutput = requireEnv("GITHUB_OUTPUT");
  appendFileSync(githubOutput, `selected_files=${json}\n`, "utf8");
  console.log(`Selección segura: ${selectedFiles.join(", ")}`);
}

function runWriteResult() {
  const selectedFiles = JSON.parse(requireEnv("SELECTED_FILES"));
  const record = buildAuditRecord({
    structuredOutput: requireEnv("STRUCTURED_OUTPUT"),
    selectedFiles,
    executionFile: process.env.CLAUDE_EXECUTION_FILE || undefined,
  });
  const outputPath = resolve(process.argv[3] ?? "claude-max-shadow-result.json");
  writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Registro sanitizado creado: ${outputPath}`);
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const command = process.argv[2];
  if (command === "select") runSelect();
  else if (command === "write-result") runWriteResult();
  else throw new Error("Uso: shadow-review.mjs select | write-result [archivo-salida]");
}
