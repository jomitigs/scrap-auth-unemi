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
      fs.writeFileSync(f, f === PROGRESS_FILE ? JSON.stringify({ lastIndex: 0 }, null, 2) : '[]');
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

/** Añade un lote (array) de elementos al archivo-JSON que contiene un arreglo */
async function appendBatchToArrayFile(filePath: string, batch: any[]) {
  if (batch.length === 0) return;
  const arr = readJsonArraySafe(filePath);
  // concatenación masiva para minimizar escrituras
  Array.prototype.push.apply(arr, batch);
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

export async function getUsersAssignment() {
  ensureDataFiles();

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
  let index = 0;
  let pending: Promise<{
    allIdsEntry: Record<string, unknown>;
    successEntry?: Record<string, unknown>;
  } | null>[] = [];

  try {
    for (const seq of gen) {
      // programar request; ya no escribe a disco: devuelve los registros a persistir
      const p = requestForKeyWithBackoff(seq, index);
      // envolvemos para que nunca rechace y podamos usar Promise.allSettled eficientemente
      pending.push(
        p
          .then((res) => res)
          .catch((err) => {
            console.error(`Error en clave ${fixedPrefix + seq} [${index}]:`, err);
            return null;
          })
      );

      index++;

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
        await fs.promises.writeFile(PROGRESS_FILE, JSON.stringify({ lastIndex: index }, null, 2));

        console.log(`Progreso: ${index} claves procesadas (lote ${BATCH_SIZE}).`);
        pending = [];
      }

      // (opcional de pruebas)
      // if (index >= 5000) break;
    }

    // Vaciar resto
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
      await fs.promises.writeFile(PROGRESS_FILE, JSON.stringify({ lastIndex: index }, null, 2));

      console.log(`Progreso final: ${index} claves procesadas (resto ${pending.length}).`);
    }
  } finally {
    clearInterval(refreshHandle);
    await close();
  }

  return { browser, page, cdpSession };
}

// (Opcional para ejecución directa)
// (async () => { await getUsersAssignment(); })().catch(console.error);
