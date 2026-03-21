import type { OpenClawConfig } from "../../../config/config.js";
import { parseToolsBySenderTypedKey } from "../../../config/types.tools.js";
import { asObjectRecord } from "./object.js";

export type LegacyToolsBySenderKeyHit = {
  toolsBySenderPath: Array<string | number>;
  pathLabel: string;
  key: string;
  targetKey: string;
};

function formatConfigPath(parts: Array<string | number>): string {
  if (parts.length === 0) {
    return "<root>";
  }
  let out = "";
  for (const part of parts) {
    if (typeof part === "number") {
      out += `[${part}]`;
      continue;
    }
    out = out ? `${out}.${part}` : part;
  }
  return out || "<root>";
}

function resolveConfigPathTarget(root: unknown, path: Array<string | number>): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[part];
      continue;
    }
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function collectLegacyToolsBySenderKeyHits(
  value: unknown,
  pathParts: Array<string | number>,
  hits: LegacyToolsBySenderKeyHit[],
) {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      collectLegacyToolsBySenderKeyHits(entry, [...pathParts, index], hits);
    }
    return;
  }
  const record = asObjectRecord(value);
  if (!record) {
    return;
  }

  const toolsBySender = asObjectRecord(record.toolsBySender);
  if (toolsBySender) {
    const path = [...pathParts, "toolsBySender"];
    const pathLabel = formatConfigPath(path);
    for (const rawKey of Object.keys(toolsBySender)) {
      const trimmed = rawKey.trim();
      if (!trimmed || trimmed === "*" || parseToolsBySenderTypedKey(trimmed)) {
        continue;
      }
      hits.push({
        toolsBySenderPath: path,
        pathLabel,
        key: rawKey,
        targetKey: `id:${trimmed}`,
      });
    }
  }

  for (const [key, nested] of Object.entries(record)) {
    if (key === "toolsBySender") {
      continue;
    }
    collectLegacyToolsBySenderKeyHits(nested, [...pathParts, key], hits);
  }
}

export function scanLegacyToolsBySenderKeys(cfg: OpenClawConfig): LegacyToolsBySenderKeyHit[] {
  const hits: LegacyToolsBySenderKeyHit[] = [];
  collectLegacyToolsBySenderKeyHits(cfg, [], hits);
  return hits;
}

export function maybeRepairLegacyToolsBySenderKeys(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const next = structuredClone(cfg);
  const hits = scanLegacyToolsBySenderKeys(next);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const summary = new Map<string, { migrated: number; dropped: number; examples: string[] }>();
  let changed = false;

  for (const hit of hits) {
    const toolsBySender = asObjectRecord(resolveConfigPathTarget(next, hit.toolsBySenderPath));
    if (!toolsBySender || !(hit.key in toolsBySender)) {
      continue;
    }
    const row = summary.get(hit.pathLabel) ?? { migrated: 0, dropped: 0, examples: [] };

    if (toolsBySender[hit.targetKey] === undefined) {
      toolsBySender[hit.targetKey] = toolsBySender[hit.key];
      row.migrated++;
      if (row.examples.length < 3) {
        row.examples.push(`${hit.key} -> ${hit.targetKey}`);
      }
    } else {
      row.dropped++;
      if (row.examples.length < 3) {
        row.examples.push(`${hit.key} (kept existing ${hit.targetKey})`);
      }
    }
    delete toolsBySender[hit.key];
    summary.set(hit.pathLabel, row);
    changed = true;
  }

  if (!changed) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  for (const [pathLabel, row] of summary) {
    if (row.migrated > 0) {
      const suffix = row.examples.length > 0 ? ` (${row.examples.join(", ")})` : "";
      changes.push(
        `- ${pathLabel}: migrated ${row.migrated} legacy key${row.migrated === 1 ? "" : "s"} to typed id: entries${suffix}.`,
      );
    }
    if (row.dropped > 0) {
      changes.push(
        `- ${pathLabel}: removed ${row.dropped} legacy key${row.dropped === 1 ? "" : "s"} where typed id: entries already existed.`,
      );
    }
  }

  return { config: next, changes };
}
