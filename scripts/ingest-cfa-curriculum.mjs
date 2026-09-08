import {
  chmodSync,
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = resolve(PROJECT_DIR, ".env.local");
const CURRICULUM_DIR = resolve(PROJECT_DIR, "..", "课程");
const VECTOR_STORE_NAME = "CFA Tutor · 2026 CFA Level I Curriculum";
const VECTOR_STORE_METADATA = {
  project: "cfa-tutor",
  curriculum: "2026-cfa-level-i",
};
const EXPECTED_FILES = Array.from(
  { length: 10 },
  (_, index) => `cfa-program2026L1V${index + 1}.pdf`,
);

function readLocalEnv() {
  if (!existsSync(ENV_PATH)) return { text: "", values: {} };

  const text = readFileSync(ENV_PATH, "utf8");
  const values = {};

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }

  return { text, values };
}

function saveVectorStoreId(envText, vectorStoreId) {
  const entry = `CFA_VECTOR_STORE_ID=${vectorStoreId}`;
  const pattern = /^\s*CFA_VECTOR_STORE_ID\s*=.*$/m;
  const nextText = pattern.test(envText)
    ? envText.replace(pattern, entry)
    : `${envText.trimEnd()}${envText.trim() ? "\n" : ""}${entry}\n`;

  writeFileSync(ENV_PATH, nextText, { encoding: "utf8", mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
}

function getStatus(error) {
  return typeof error === "object" && error && "status" in error
    ? Number(error.status)
    : null;
}

function volumeFromFilename(filename) {
  const match = filename.match(/^cfa-program2026L1V(\d+)\.pdf$/);
  return match ? Number(match[1]) : null;
}

async function findReusableVectorStore(client) {
  const matches = [];

  for await (const store of client.vectorStores.list({ limit: 100 })) {
    if (
      store.status !== "expired" &&
      (store.name === VECTOR_STORE_NAME ||
        (store.metadata?.project === VECTOR_STORE_METADATA.project &&
          store.metadata?.curriculum === VECTOR_STORE_METADATA.curriculum))
    ) {
      matches.push(store);
    }
  }

  return matches.sort((left, right) => right.created_at - left.created_at)[0] ?? null;
}

async function resolveVectorStore(client, configuredId) {
  if (configuredId) {
    try {
      const configured = await client.vectorStores.retrieve(configuredId);
      if (configured.status !== "expired") {
        return { store: configured, action: "reused from .env.local" };
      }
    } catch (error) {
      if (getStatus(error) !== 404) throw error;
    }
  }

  const reusable = await findReusableVectorStore(client);
  if (reusable) {
    return { store: reusable, action: "reused from OpenAI by project metadata" };
  }

  const created = await client.vectorStores.create({
    name: VECTOR_STORE_NAME,
    description: "Official 2026 CFA Level I curriculum for the private CFA Tutor app.",
    metadata: VECTOR_STORE_METADATA,
  });
  return { store: created, action: "created" };
}

async function listAttachedFiles(client, vectorStoreId) {
  const attached = [];

  for await (const vectorFile of client.vectorStores.files.list(vectorStoreId, {
    limit: 100,
    order: "asc",
  })) {
    try {
      const file = await client.files.retrieve(vectorFile.id);
      attached.push({ file, vectorFile });
    } catch (error) {
      if (getStatus(error) !== 404) throw error;
    }
  }

  return attached;
}

async function main() {
  const localFiles = EXPECTED_FILES.map((filename) => {
    const path = resolve(CURRICULUM_DIR, filename);
    if (!existsSync(path)) throw new Error(`Missing expected PDF: ${path}`);

    const stat = statSync(path);
    const signature = readFileSync(path).subarray(0, 5).toString("ascii");
    if (!stat.isFile() || stat.size === 0 || signature !== "%PDF-") {
      throw new Error(`Invalid PDF: ${path}`);
    }

    return { filename, path, size: stat.size, volume: volumeFromFilename(filename) };
  });

  const env = readLocalEnv();
  const apiKey = process.env.OPENAI_API_KEY || env.values.OPENAI_API_KEY;
  if (!apiKey || apiKey === "PASTE_YOUR_KEY_HERE") {
    throw new Error("OPENAI_API_KEY is not configured in .env.local.");
  }

  console.log(`Validated ${localFiles.length} local PDF files.`);

  const client = new OpenAI({ apiKey });
  const { store, action } = await resolveVectorStore(
    client,
    process.env.CFA_VECTOR_STORE_ID || env.values.CFA_VECTOR_STORE_ID,
  );
  saveVectorStoreId(env.text, store.id);
  console.log(`Vector store ${action}: ${store.id}`);
  console.log("Saved CFA_VECTOR_STORE_ID in the git-ignored .env.local file.");

  const initialAttached = await listAttachedFiles(client, store.id);
  const results = [];

  for (const localFile of localFiles) {
    let match = initialAttached.find(
      ({ file }) => file.filename === localFile.filename && file.bytes === localFile.size,
    );

    try {
      if (match?.vectorFile.status === "in_progress") {
        const polled = await client.vectorStores.files.poll(store.id, match.file.id);
        match = { ...match, vectorFile: polled };
      }

      if (match?.vectorFile.status === "completed") {
        results.push({ filename: localFile.filename, status: "completed", action: "reused" });
        console.log(`REUSED    ${localFile.filename}`);
        continue;
      }

      let vectorFile;
      if (match) {
        await client.vectorStores.files.delete(match.file.id, { vector_store_id: store.id });
        vectorFile = await client.vectorStores.files.createAndPoll(store.id, {
          file_id: match.file.id,
          attributes: {
            curriculum: "2026-cfa-level-i",
            volume: localFile.volume,
          },
        });
      } else {
        vectorFile = await client.vectorStores.files.uploadAndPoll(
          store.id,
          createReadStream(localFile.path),
        );
        if (vectorFile.status === "completed") {
          vectorFile = await client.vectorStores.files.update(vectorFile.id, {
            vector_store_id: store.id,
            attributes: {
              curriculum: "2026-cfa-level-i",
              volume: localFile.volume,
            },
          });
        }
      }

      if (vectorFile.status !== "completed") {
        const detail = vectorFile.last_error?.message || vectorFile.status;
        throw new Error(detail);
      }

      results.push({ filename: localFile.filename, status: "completed", action: "indexed" });
      console.log(`INDEXED   ${localFile.filename}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown ingestion error";
      results.push({ filename: localFile.filename, status: "failed", action: message });
      console.error(`FAILED    ${localFile.filename}: ${message}`);
    }
  }

  const succeeded = results.filter((result) => result.status === "completed");
  const failed = results.filter((result) => result.status === "failed");
  const finalStore = await client.vectorStores.retrieve(store.id);

  console.log("\nIngestion summary");
  console.log(`- Vector store: ${store.id} (${action})`);
  console.log(`- Successfully indexed: ${succeeded.length}/${EXPECTED_FILES.length}`);
  console.log(`- Failed: ${failed.length}`);
  console.log(`- OpenAI file counts: ${JSON.stringify(finalStore.file_counts)}`);

  if (failed.length > 0 || succeeded.length !== EXPECTED_FILES.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown ingestion error";
  console.error(`Ingestion stopped: ${message}`);
  process.exitCode = 1;
});
