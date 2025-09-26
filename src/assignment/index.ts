// src/assignment/index.ts
import { createBrowser } from '../utils/create-browser.js';
import { login, refreshToken } from './login-token.js';
import {
  generateSequences,
  fixedPrefix,
  PROGRESS_FILE,
  DATA_DIR,
  requestForKeyWithBackoff,
  BATCH_SIZE,
  ALL_IDS_FILE,
  SUCCESS_FILE,
} from './manage-data.js';
import fs from 'node:fs';

/** Garantiza la existencia de la carpeta de datos y archivos JSON base */
function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`Carpeta creada: ${DATA_DIR}`);
  }
  for (const f of [ALL_IDS_FILE, SUCCESS_FILE, PROGRESS_FILE]) {
    if (!fs.existsSync(f)) {
      fs.writeFileSync(
        f,
        f === PROGRESS_FILE ? JSON.stringify({ lastIndex: 0 }, null, 2) : '[]'
      );
    }
  }
}

/** Lee un arreglo JSON con tolerancia a errores */
function readJsonArraySafe(filePath: string): any[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Lee el índice de progreso con tolerancia a errores */
function readProgressIndex(): number {
  try {
    const raw = fs.readFileSync(PROGRESS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const n = Number(parsed?.lastIndex ?? 0);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Añade un lote (array) de elementos al archivo-JSON que contiene un arreglo */
async function appendBatchToArrayFile(filePath: string, batch: any[]) {
  if (batch.length === 0) return;
  const arr = readJsonArraySafe(filePath);
  Array.prototype.push.apply(arr, batch); // concatenación masiva
  await fs.promises.writeFile(filePath, JSON.stringify(arr, null, 2));
}

/** Captura metadatos reales del navegador para usarlos en el login */
async function getClientMeta(page: import('puppeteer').Page) {
  const { userAgent, platform, screenSize } = await page.evaluate(() => {
    const ua = navigator.userAgent;
    const plat = (navigator as any).userAgentData?.platform || navigator.platform || 'Unknown';
    const scr = `${screen.width} x ${screen.height}`;
    return { userAgent: ua, platform: plat, screenSize: scr };
  });
  return { userAgent, platform, screenSize };
}

/**
 * Recorre TODAS las secuencias, pero reanuda desde `startIndex` (si > 0).
 * Esto evita recalcular combinatorias complejas. El “salto” simplemente
 * descarta las primeras `startIndex` secuencias del generador.
 */
export async function getUsersAssignment() {
  ensureDataFiles();

  // Lee el índice inicial desde progress.json (si existe)
  const startIndex = readProgressIndex();
  if (startIndex > 0) {
    console.log(`Reanudando desde lastIndex=${startIndex}`);
  }

  const url = 'https://admisiongrado.unemi.edu.ec';

  // 1) Iniciar navegador (usa tu implementación existente)
  const { browser, page, cdpSession, close } = await createBrowser(url);

  // 2) Obtener metadatos reales de cliente desde el navegador
  const meta = await getClientMeta(page);

  // 3) Login y programación de refresh del token cada 5 minutos
  await login({
    clientNavegador: meta.userAgent,
    clientOS: meta.platform,
    clientScreensize: meta.screenSize,
  });

  const refreshHandle = setInterval(() => {
    refreshToken().catch((e) => console.warn('Refresh token error:', e?.message || e));
  }, 5 * 60 * 1000);

  // 4) Procesamiento en lotes (concurrencia = BATCH_SIZE)
  const gen = generateSequences();
  let index = 0; // índice global real (0..N)
  let scheduled = 0; // cuántas tareas se han programado en esta corrida
  let pending: Promise<{
    allIdsEntry: Record<string, unknown>;
    successEntry?: Record<string, unknown>;
  } | null>[] = [];

  try {
    for (const seq of gen) {
      // Si aún no alcanzamos el índice guardado, saltar
      if (index < startIndex) {
        index++;
        continue;
      }

      // programar request; devuelve registros a persistir (nunca rechaza)
      const p = requestForKeyWithBackoff(seq, index)
        .then((res) => res)
        .catch((err) => {
          console.error(`Error en clave ${fixedPrefix + seq} [${index}]:`, err);
          return null;
        });

      pending.push(p);
      scheduled++;
      index++;

      // Cuando el buffer alcanza el tamaño del lote, flush a disco + progreso
      if (pending.length === BATCH_SIZE) {
        const results = await Promise.allSettled(pending);
        const allIdsBatch: Record<string, unknown>[] = [];
        const successBatch: Record<string, unknown>[] = [];

        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) {
            allIdsBatch.push(r.value.allIdsEntry);
            if (r.value.successEntry) successBatch.push(r.value.successEntry);
          }
        }

        await appendBatchToArrayFile(ALL_IDS_FILE, allIdsBatch);
        await appendBatchToArrayFile(SUCCESS_FILE, successBatch);
        await fs.promises.writeFile(
          PROGRESS_FILE,
          JSON.stringify({ lastIndex: index }, null, 2)
        );

        console.log(
          `Progreso: ${index} claves procesadas (lote=${BATCH_SIZE}, programadas=${scheduled}).`
        );
        pending = [];
      }

      // (opcional de pruebas)
      // if (scheduled >= 5000) break;
    }

    // Vaciar resto (si hay)
    if (pending.length > 0) {
      const results = await Promise.allSettled(pending);
      const allIdsBatch: Record<string, unknown>[] = [];
      const successBatch: Record<string, unknown>[] = [];

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          allIdsBatch.push(r.value.allIdsEntry);
          if (r.value.successEntry) successBatch.push(r.value.successEntry);
        }
      }

      await appendBatchToArrayFile(ALL_IDS_FILE, allIdsBatch);
      await appendBatchToArrayFile(SUCCESS_FILE, successBatch);
      await fs.promises.writeFile(
        PROGRESS_FILE,
        JSON.stringify({ lastIndex: index }, null, 2)
      );

      console.log(
        `Progreso final: ${index} claves procesadas (resto=${pending.length}, programadas=${scheduled}).`
      );
    }
  } finally {
    clearInterval(refreshHandle);
    await close();
  }

  return { browser, page, cdpSession };
}

// (Opcional para ejecución directa)
// (async () => { await getUsersAssignment(); })().catch(console.error);
