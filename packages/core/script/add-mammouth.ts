#!/usr/bin/env bun
// Adds Mammouth AI's public model catalog to providers/mammouth.
//
// Mammouth is a relay, so every model inherits its model facts from the lab
// entry in models/ and this script writes only provider-specific overrides:
// price (including cache, context tiers, image output and audio input), served
// limits, and a name for Mammouth-only aliases.
//
//   bun ./packages/core/script/add-mammouth.ts
//   bun ./packages/core/script/add-mammouth.ts --dry-run
//   bun ./packages/core/script/add-mammouth.ts --update
//   bun ./packages/core/script/add-mammouth.ts --prune
//
// By default existing files are left alone; pass --update to rewrite them.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { formatModelV2 } from "../src/model-file-v2.js";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const MODELS_DIR = path.join(ROOT, "models");
const PROVIDER_DIR = path.join(ROOT, "providers", "mammouth");
const PROVIDER_MODELS_DIR = path.join(PROVIDER_DIR, "models");
const SOURCE = "https://api.mammouth.ai/public/model/info";
const ACCESS_DATE = "2026-10-26";
const DEFAULT_ENDPOINT = SOURCE;

// Mammouth IDs that don't match a lab filename, mapped to the canonical lab entry.
const ALIASES: Record<string, string> = {
  "claude-fable-5.1": "anthropic/claude-fable-5-1",
  "claude-opus-5-5-fast": "anthropic/claude-opus-5-5",
  "claude-opus-5-fast": "anthropic/claude-opus-5",
  "deepseek-v3.1-terminus": "deepseek/deepseek-v3.1",
  "gpt-5.1-chat": "openai/gpt-5.1-chat-latest",
  "gpt-5.2-chat": "openai/gpt-5.2-chat-latest",
  "kimi-k3-fast": "moonshotai/kimi-k3",
  "llama-4-maverick": "meta/llama-4-maverick-17b-instruct",
  "llama-4-scout": "meta/llama-4-scout-17b-instruct",
  "mammouth-recommended": "zhipuai/glm-5.3-flash",
  "mistral-large-3": "mistral/mistral-large-2512",
  "qwen3-coder": "alibaba/qwen3-coder-480b-a35b-instruct",
};

const NAMES: Record<string, string> = {
  "claude-opus-5-5-fast": "Claude Opus 5.5 Fast",
  "claude-opus-5-fast": "Claude Opus 5 Fast",
  "deepseek-v3.1-terminus": "DeepSeek V3.1 Terminus",
  "kimi-k3-fast": "Kimi K3 Fast",
  "llama-4-maverick": "Llama 4 Maverick",
  "llama-4-scout": "Llama 4 Scout",
  "mammouth-recommended": "Mammouth Recommended",
  "qwen3-coder": "Qwen3 Coder",
};

const DESCRIPTIONS: Record<string, string> = {
  "mammouth-recommended":
    "Dynamic Mammouth pick that routes to its current best price-performance model",
};

type Options = {
  input?: string;
  dryRun: boolean;
  update: boolean;
  prune: boolean;
  check: boolean;
  skipUnresolved: boolean;
};

type MammouthModel = {
  id: string;
  model_info: {
    max_input_tokens: number | null;
    max_output_tokens: number | null;
    input_cost_per_token: number;
    output_cost_per_token: number;
    [key: string]: unknown;
  };
};

type LabModel = {
  lab: string;
  id: string;
  file: string;
};

type ReasoningControls = {
  supported: true;
  default?: unknown;
  toggle?: boolean;
  effort?: string[];
  budget?: Record<string, number>;
};

type ReasoningSource = {
  provider: string;
  controls: ReasoningControls;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dryRun: false,
    update: false,
    prune: false,
    check: false,
    skipUnresolved: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--input") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--input needs a path");
      options.input = value;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--update") {
      options.update = true;
    } else if (arg === "--prune") {
      options.prune = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--skip-unresolved") {
      options.skipUnresolved = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun ./packages/core/script/add-mammouth.ts [--input file.json] [--dry-run] [--update] [--prune] [--check] [--skip-unresolved]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function loadLabModels() {
  const byId = new Map<string, LabModel>();
  for (const lab of await readdir(MODELS_DIR, { withFileTypes: true })) {
    if (!lab.isDirectory()) continue;
    const labDir = path.join(MODELS_DIR, lab.name);
    for (const entry of await readdir(labDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
      const id = entry.name.slice(0, -".toml".length);
      byId.set(id.toLowerCase(), {
        lab: lab.name,
        id,
        file: path.join(labDir, entry.name),
      });
    }
  }
  return byId;
}

function findLabModel(byId: Map<string, LabModel>, reference: string) {
  if (reference.includes("/")) {
    const file = path.join(MODELS_DIR, `${reference}.toml`);
    if (!existsSync(file)) return undefined;
    const [lab, ...rest] = reference.split("/");
    return { lab: lab!, id: rest.join("/"), file };
  }
  return byId.get(reference.toLowerCase());
}

function resolveLabModel(model: MammouthModel, byId: Map<string, LabModel>) {
  const alias = ALIASES[model.id];
  if (alias !== undefined) return findLabModel(byId, alias);
  return byId.get(model.id.toLowerCase());
}

async function loadCatalog(options: Options): Promise<MammouthModel[]> {
  const source = options.input ?? DEFAULT_ENDPOINT;
  const response = options.input
    ? await readFile(source, "utf8")
    : await fetch(source).then(async (result) => {
        if (!result.ok) throw new Error(`${source} returned ${result.status}`);
        return result.text();
      });
  const parsed = JSON.parse(response) as { data?: unknown };
  if (!Array.isArray(parsed.data)) throw new Error(`${source} did not return a data array`);
  const models: MammouthModel[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.data as Array<Record<string, unknown>>) {
    // /public/model/info calls the id `model_name`; /public/models calls it `id`.
    const id =
      typeof entry.id === "string"
        ? entry.id
        : typeof entry.model_name === "string"
          ? entry.model_name
          : undefined;
    if (id === undefined || id.length === 0) {
      throw new Error("catalog contains a model without an id");
    }
    if (seen.has(id)) throw new Error(`duplicate model id: ${id}`);
    seen.add(id);
    const info = entry.model_info as MammouthModel["model_info"] | undefined;
    if (
      !info ||
      typeof info.input_cost_per_token !== "number" ||
      typeof info.output_cost_per_token !== "number"
    ) {
      throw new Error(`${id} is missing pricing`);
    }
    models.push({ ...entry, id, model_info: info });
  }
  return models;
}

function pricePerMillion(perToken: number) {
  return Number((perToken * 1_000_000).toFixed(6));
}

function perMillion(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? pricePerMillion(value)
    : undefined;
}

function pricingOverrides(info: MammouthModel["model_info"]) {
  const value = info.pricing_overrides;
  return new Set(
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
  );
}

function cachePrice(
  read: number | undefined,
  write5m: number | undefined,
  write1h: number | undefined,
) {
  if (read === undefined && write5m === undefined && write1h === undefined) return undefined;
  const cache: Record<string, number | Record<string, number>> = {};
  if (read !== undefined) cache.read = read;
  if (write5m !== undefined && write1h !== undefined) {
    cache.write = { "5m": write5m, "1h": write1h };
  } else if (write5m !== undefined) {
    cache.write = write5m;
  } else if (write1h !== undefined) {
    cache.write = { "1h": write1h };
  }
  return cache;
}

function baseCache(info: MammouthModel["model_info"]) {
  const overrides = pricingOverrides(info);
  const write5m = perMillion(info.cache_creation_input_token_cost);
  return cachePrice(
    perMillion(info.cache_read_input_token_cost),
    write5m === 0 && !overrides.has("cache_creation_input_token_cost") ? undefined : write5m,
    perMillion(info.cache_creation_input_token_cost_above_1hr),
  );
}

function hasModality(
  base: Record<string, any>,
  direction: "input" | "output",
  kind: string,
) {
  const values = base.modalities?.[direction];
  return (
    Array.isArray(values) &&
    values.some(
      (value) => typeof value === "string" && (value === kind || value.startsWith(`${kind}/`)),
    )
  );
}

type CostOverride = {
  when: { context: { gt: number } };
  price?: number;
  cache?: Record<string, number | Record<string, number>>;
};

function contextCosts(info: MammouthModel["model_info"]) {
  const overrides = pricingOverrides(info);
  const thresholds = new Set<number>();
  for (const key of overrides) {
    const match =
      /^(?:input|output|cache_read|cache_creation)_cost_per_token_above_(\d+)k_tokens$/.exec(key);
    if (match !== null) thresholds.add(Number(match[1]));
  }

  const inputBase = pricePerMillion(info.input_cost_per_token);
  const outputBase = pricePerMillion(info.output_cost_per_token);
  const readBase = perMillion(info.cache_read_input_token_cost);
  const writeBase = perMillion(info.cache_creation_input_token_cost);
  const write1hBase = perMillion(info.cache_creation_input_token_cost_above_1hr);

  const input: CostOverride[] = [];
  const output: CostOverride[] = [];
  for (const threshold of [...thresholds].sort((a, b) => a - b)) {
    const suffix = `_above_${threshold}k_tokens`;
    const inputKey = `input_cost_per_token${suffix}`;
    const outputKey = `output_cost_per_token${suffix}`;
    const readKey = `cache_read_input_token_cost${suffix}`;
    const writeKey = `cache_creation_input_token_cost${suffix}`;
    const write1hKey = `cache_creation_input_token_cost_above_1hr_above_${threshold}k_tokens`;
    const hasOverride = [inputKey, outputKey, readKey, writeKey, write1hKey].some((key) =>
      overrides.has(key),
    );
    // A tier field Mammouth didn't override is inherited from upstream. Keep it
    // when another price at the same threshold was overridden and it still moves
    // in the expected direction; otherwise it can be a stale upstream price.
    const tierPrice = (key: string, base: number | undefined) => {
      const value = perMillion(info[key]);
      if (value === undefined) return undefined;
      if (overrides.has(key)) return value;
      return hasOverride && (base === undefined || value >= base) ? value : undefined;
    };

    const inputPrice = tierPrice(inputKey, inputBase);
    const outputPrice = tierPrice(outputKey, outputBase);
    const read = tierPrice(readKey, readBase);
    const write5m = tierPrice(writeKey, writeBase);
    const explicit1h = tierPrice(write1hKey, write1hBase);
    // Anthropic-style 1h cache writes cost 2x the input price. The source omits
    // the tiered 1h field when it follows that rule, so derive it when needed.
    const write1h =
      explicit1h ??
      (write1hBase !== undefined && inputPrice !== undefined
        ? Number((inputPrice * 2).toFixed(6))
        : undefined);
    const cache = cachePrice(
      read !== undefined && read !== readBase ? read : undefined,
      write5m !== undefined && write5m !== writeBase ? write5m : undefined,
      write1h !== undefined && write1h !== write1hBase ? write1h : undefined,
    );

    const when = { context: { gt: threshold * 1_000 } };
    if ((inputPrice !== undefined && inputPrice !== inputBase) || cache !== undefined) {
      input.push({
        when,
        ...(inputPrice !== undefined && inputPrice !== inputBase ? { price: inputPrice } : {}),
        ...(cache !== undefined ? { cache } : {}),
      });
    }
    if (outputPrice !== undefined && outputPrice !== outputBase) {
      output.push({ when, price: outputPrice });
    }
  }
  return { input, output };
}

function pickControls(reasoning: Record<string, any>): ReasoningControls | undefined {
  const controls: ReasoningControls = { supported: true };
  if (reasoning.default !== undefined) controls.default = reasoning.default;
  if (reasoning.toggle === true) controls.toggle = true;
  if (Array.isArray(reasoning.effort) && reasoning.effort.length > 0) {
    controls.effort = reasoning.effort as string[];
  }
  if (reasoning.budget !== undefined && typeof reasoning.budget === "object") {
    controls.budget = reasoning.budget as Record<string, number>;
  }
  if (
    controls.default === undefined &&
    controls.toggle === undefined &&
    controls.effort === undefined &&
    controls.budget === undefined
  ) {
    return undefined;
  }
  return controls;
}

function sourcePriority(provider: string, lab: string) {
  if (provider === "openrouter") return 0;
  if (provider === lab) return 1;
  if (
    provider === "crossmodel" ||
    provider === "kilo" ||
    provider === "llmgateway" ||
    provider === "prime" ||
    provider === "requesty" ||
    provider === "venice" ||
    provider === "vercel"
  ) {
    return 2;
  }
  return 3;
}

function controlScore(controls: ReasoningControls) {
  return (
    (controls.effort?.length ?? 0) +
    (controls.toggle === true ? 1 : 0) +
    (controls.budget === undefined ? 0 : 1) +
    (controls.default === undefined ? 0 : 1)
  );
}

async function loadReasoningIndex(
  baseModels: Set<string>,
  labByBase: Map<string, string>,
) {
  const index = new Map<string, ReasoningSource & { priority: number; score: number }>();
  const providersDir = path.join(ROOT, "providers");
  for (const provider of await readdir(providersDir, { withFileTypes: true })) {
    if (!provider.isDirectory() || provider.name === "mammouth") continue;
    for (const file of await listTomlFiles(path.join(providersDir, provider.name, "models"))) {
      const parsed = Bun.TOML.parse(await readFile(file, "utf8")) as Record<string, any>;
      const base = parsed.base_model;
      if (typeof base !== "string" || !baseModels.has(base)) continue;
      const reasoning = parsed.capabilities?.reasoning;
      if (reasoning?.supported !== true) continue;
      const controls = pickControls(reasoning);
      if (controls === undefined) continue;
      const priority = sourcePriority(provider.name, labByBase.get(base) ?? "");
      const score = controlScore(controls);
      const existing = index.get(base);
      if (
        existing !== undefined &&
        (existing.priority < priority ||
          (existing.priority === priority && existing.score >= score))
      ) {
        continue;
      }
      index.set(base, { provider: provider.name, controls, priority, score });
    }
  }
  return index;
}

function buildLimit(
  type: string,
  info: MammouthModel["model_info"],
  base: Record<string, any>,
) {
  if (type === "image") return undefined;
  const baseLimit = base.limit ?? {};
  const limit: Record<string, number> = {};
  if (info.max_input_tokens !== null && info.max_input_tokens !== baseLimit.context) {
    limit.context = info.max_input_tokens;
  }
  if (
    type !== "embedding" &&
    info.max_output_tokens !== null &&
    info.max_output_tokens !== baseLimit.output
  ) {
    limit.output = info.max_output_tokens;
  }
  return Object.keys(limit).length > 0 ? limit : undefined;
}

function headerFor(
  model: MammouthModel,
  base: string,
  reasoningSource?: string,
) {
  const lines = [
    `# Source: ${SOURCE} (accessed ${ACCESS_DATE}).`,
    "# Prices are USD per 1M tokens. Mammouth is a relay; model facts are inherited from the lab entry.",
  ];
  if (reasoningSource !== undefined) {
    lines.push(
      `# Reasoning controls mirror the established ${reasoningSource} entry for this base model.`,
    );
  }
  if (model.id === "mammouth-recommended") {
    lines.push(
      `# Dynamic alias. On ${ACCESS_DATE} it routes to zhipuai/glm-5.3-flash with minimax/MiniMax-M3 as fallback.`,
    );
  } else if (model.id.endsWith("-fast")) {
    lines.push(`# Mammouth serves this as a distinct fast ID based on ${base}.`);
  }
  return `${lines.join("\n")}\n`;
}

async function buildFile(
  model: MammouthModel,
  lab: LabModel,
  controls: ReasoningSource | undefined,
) {
  const base = Bun.TOML.parse(await readFile(lab.file, "utf8")) as Record<string, any>;
  const type = typeof base.type === "string" ? base.type : "chat";
  const info = model.model_info;

  const doc: Record<string, unknown> = { schema: 2 };
  if (base.v2_only === true) doc.v2_only = true;
  doc.base_model = `${lab.lab}/${lab.id}`;
  if (NAMES[model.id] !== undefined) doc.name = NAMES[model.id];
  if (DESCRIPTIONS[model.id] !== undefined) doc.description = DESCRIPTIONS[model.id];

  const limit = buildLimit(type, info, base);
  if (limit !== undefined) doc.limit = limit;

  if (base.capabilities?.reasoning?.supported === true && controls !== undefined) {
    doc.capabilities = { reasoning: controls.controls };
  }

  if (type === "embedding") {
    doc.api = { embeddings: { sdk: { opencodeai: "none" } } };
  }

  const tiers = contextCosts(info);
  const input: Record<string, unknown> = {
    price: pricePerMillion(info.input_cost_per_token),
  };
  const cache = baseCache(info);
  if (cache !== undefined) input.cache = cache;
  if (tiers.input.length > 0) input.overrides = tiers.input;

  const textOutput =
    type === "embedding" || (type === "image" && !hasModality(base, "output", "text"))
      ? undefined
      : {
          price: pricePerMillion(info.output_cost_per_token),
          ...(tiers.output.length > 0 ? { overrides: tiers.output } : {}),
        };

  const cost: Record<string, unknown> = {
    text: { input, ...(textOutput !== undefined ? { output: textOutput } : {}) },
  };

  const imageOutput = type === "image" ? perMillion(info.output_cost_per_image_token) : undefined;
  if (imageOutput !== undefined) cost.image = { output: { price: imageOutput } };

  const audioInput = hasModality(base, "input", "audio")
    ? perMillion(info.input_cost_per_audio_token)
    : undefined;
  if (audioInput !== undefined) {
    const read = perMillion(info.cache_read_input_audio_token_cost);
    cost.audio = {
      input: { price: audioInput, ...(read !== undefined ? { cache: { read } } : {}) },
    };
  }

  doc.cost = cost;

  return `${headerFor(model, `${lab.lab}/${lab.id}`, controls?.provider)}${formatModelV2(doc)}`;
}

async function listTomlFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listTomlFiles(full)));
    else if (entry.isFile() && entry.name.endsWith(".toml")) out.push(full);
  }
  return out;
}

function modelPath(id: string) {
  const parts = id.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`unsafe model id: ${id}`);
  }
  return path.join(PROVIDER_MODELS_DIR, ...parts) + ".toml";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(path.join(PROVIDER_DIR, "provider.toml"))) {
    throw new Error("providers/mammouth/provider.toml is missing");
  }

  const [catalog, byId] = await Promise.all([loadCatalog(options), loadLabModels()]);
  const unresolved: string[] = [];
  const resolved: Array<{ model: MammouthModel; lab: LabModel; base: string }> = [];

  for (const model of catalog) {
    const lab = resolveLabModel(model, byId);
    if (lab === undefined) {
      unresolved.push(model.id);
      continue;
    }
    resolved.push({ model, lab, base: `${lab.lab}/${lab.id}` });
  }

  if (unresolved.length > 0) {
    console.error(`No lab model found for ${unresolved.length} Mammouth ID(s):`);
    for (const id of unresolved) console.error(`  ${id}`);
    if (!options.skipUnresolved) process.exit(1);
  }

  const baseModels = new Set(resolved.map((item) => item.base));
  const labByBase = new Map(resolved.map((item) => [item.base, item.lab.lab]));
  const controlsByBase = await loadReasoningIndex(baseModels, labByBase);

  const missingControls: string[] = [];
  const generated = new Map<string, { file: string; content: string }>();
  for (const { model, lab, base } of resolved) {
    const labToml = Bun.TOML.parse(await readFile(lab.file, "utf8")) as Record<string, any>;
    const controls = controlsByBase.get(base);
    if (labToml.capabilities?.reasoning?.supported === true && controls === undefined) {
      missingControls.push(model.id);
      continue;
    }
    const file = modelPath(model.id);
    generated.set(model.id, { file, content: await buildFile(model, lab, controls) });
  }

  if (missingControls.length > 0) {
    console.error(
      `No reasoning controls found for ${missingControls.length} reasoning model(s):`,
    );
    for (const id of missingControls) console.error(`  ${id}`);
    process.exit(1);
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let mismatched = 0;
  let pruned = 0;

  await mkdir(PROVIDER_MODELS_DIR, { recursive: true });
  for (const { file, content } of generated.values()) {
    const existing = existsSync(file) ? await readFile(file, "utf8") : undefined;
    if (existing === content) {
      unchanged++;
      continue;
    }
    if (existing !== undefined && !options.update && !options.check) {
      skipped++;
      continue;
    }
    if (options.check) {
      mismatched++;
      console.error(`out of date: ${path.relative(ROOT, file)}`);
      continue;
    }
    if (options.dryRun) {
      console.log(`${existing === undefined ? "create" : "update"} ${path.relative(ROOT, file)}`);
    } else {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    if (existing === undefined) created++;
    else updated++;
  }

  if (options.prune) {
    const keep = new Set([...generated.values()].map((item) => path.resolve(item.file)));
    for (const file of await listTomlFiles(PROVIDER_MODELS_DIR)) {
      if (keep.has(path.resolve(file))) continue;
      if (options.dryRun || options.check) {
        console.log(`prune ${path.relative(ROOT, file)}`);
      } else {
        await unlink(file);
      }
      pruned++;
    }
  }

  console.log(
    `Mammouth: ${generated.size} models (${created} created, ${updated} updated, ${unchanged} unchanged, ${skipped} skipped, ${pruned} pruned)`,
  );
  if (options.check && (mismatched > 0 || pruned > 0)) process.exit(1);
}

await main();
