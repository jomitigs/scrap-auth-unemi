import { createBrowser } from '../utils/create-browser.js';
import { login, refreshToken } from './login-token.js';
import {
  generateSequences,
  fixedPrefix,
  PROGRESS_FILE,
  DATA_DIR,
  requestForKeyWithBackoff,
  BATCH_SIZE,
  ALL_IDS_DIR,
  SUCCESS_DIR,
  RotatingNdjsonWriter,
} from './manage-data.js';
import fs from 'node:fs';

/** Garantiza la existencia de carpeta de datos y subcarpetas */
function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`Carpeta creada: ${DATA_DIR}`);
  }
  if (!fs.existsSync(ALL_IDS_DIR)) fs.mkdirSync(ALL_IDS_DIR, { recursive: true });
  if (!fs.existsSync(SUCCESS_DIR)) fs.mkdirSync(SUCCESS_DIR, { recursive: true });

  if (!fs.existsSync(PROGRESS_FILE)) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ lastIndex: 0 }, null, 2));
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

/** Escribe el progreso de forma segura (archivo pequeño) */
async function writeProgressIndex(index: number) {
  await fs.promises.writeFile(PROGRESS_FILE, JSON.stringify({ lastIndex: index }, null, 2));
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
 * Procesa todas las secuencias con escritura NDJSON por partes.
 * Reanuda desde progress.json y continúa en la última parte creada.
 */
export async function getUsersAssignment() {
  ensureDataFiles();

  // Índice inicial desde progress.json (si existe)
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

  // 4) Writers NDJSON con rotación por peso/líneas (recuperan estado real de disco)
  const allIdsWriter = new RotatingNdjsonWriter(ALL_IDS_DIR, {
    maxBytesPerPart: 250 * 1024 * 1024, // 250 MB
    maxLinesPerPart: 500_000,
  });
  const successWriter = new RotatingNdjsonWriter(SUCCESS_DIR, {
    maxBytesPerPart: 250 * 1024 * 1024,
    maxLinesPerPart: 500_000,
  });

  // Recuperar última parte, bytes y líneas reales para continuar sin sobrescribir
  await allIdsWriter.recoverStateFromDisk();
  await successWriter.recoverStateFromDisk();

  // 5) Procesamiento en lotes (concurrencia = BATCH_SIZE)
  const gen = generateSequences();
  let index = 0; // índice global real (0..N)
  let scheduled = 0; // cuántas tareas se han programado en esta corrida
  let pending: Promise<{
    allIdsEntry: Record<string, unknown>;
    successEntry?: Record<string, unknown>;
  } | null>[] = [];

  try {
    for (const seq of gen) {
      // Saltar hasta el índice guardado
      if (index < startIndex) {
        index++;
        continue;
      }

      // programar request; devuelve registros a persistir (nunca rechaza)
      const p = (async () => {
        try {
          return await requestForKeyWithBackoff(seq, index);
        } catch (err) {
          console.error(`Error en clave ${fixedPrefix + seq} [${index}]:`, err);
          return null;
        }
      })();

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

        await allIdsWriter.appendBatch(allIdsBatch);
        await successWriter.appendBatch(successBatch);
        await writeProgressIndex(index);

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

      await allIdsWriter.appendBatch(allIdsBatch);
      await successWriter.appendBatch(successBatch);
      await writeProgressIndex(index);

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
