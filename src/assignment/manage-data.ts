import path from 'node:path';
import fs from 'node:fs';
import { token } from './login-token.js';
import { assignment } from '../config/setting.js';

/** Directorios base */
export const DATA_DIR = path.join(process.cwd(), 'data', 'assignment');

/** Subcarpetas para partes NDJSON */
export const ALL_IDS_DIR = path.join(DATA_DIR, 'allIDs');
export const SUCCESS_DIR = path.join(DATA_DIR, 'dataResults');

/** Archivo de progreso pequeño */
export const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json'); // { lastIndex }

/** Parámetros de generación de claves */
export const fixedPrefix = 'OPPQQRRSSTTUUU'; // 14 caracteres fijos
export const allowedLetters = ['M','N','O','P','Q','R','S','T','U','V','W','X','Y']; // 13 letras
export const sequenceLength = 6; // 6 letras -> total key 20 (14 + 6)

/** Concurrencia por lote declarada en settings (se asume 1000) */
export const BATCH_SIZE = Number(assignment.maxRequest) || 1000;

function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------- Generador de secuencias ----------
export function* generateSequences() {
  const len = allowedLetters.length;
  for (let i0 = 0; i0 < len; i0++) {
    for (let i1 = 0; i1 < len; i1++) {
      for (let i2 = 0; i2 < len; i2++) {
        for (let i3 = 0; i3 < len; i3++) {
          for (let i4 = 0; i4 < len; i4++) {
            for (let i5 = 0; i5 < len; i5++) {
              yield (
                allowedLetters[i0]! +
                allowedLetters[i1]! +
                allowedLetters[i2]! +
                allowedLetters[i3]! +
                allowedLetters[i4]! +
                allowedLetters[i5]!
              );
            }
          }
        }
      }
    }
  }
}

/** Opciones de rotación */
type RotateOptions = {
  maxBytesPerPart?: number;   // p.ej. 250 MB
  maxLinesPerPart?: number;   // p.ej. 500k líneas
};

/** Estado interno */
type MetaState = {
  part: number;
  lines: number;
  bytes: number;
};

/** Cuenta líneas de un archivo mediante stream (eficiente y sin choques de tipos) */
async function countFileLines(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const rs = fs.createReadStream(filePath); // sin encoding -> chunk puede ser Buffer
    rs.on('data', (chunk: any) => {
      // Normalizamos a Buffer
      const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      // 0x0a == '\n'
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) count++;
      }
    });
    rs.on('end', () => resolve(count));
    rs.on('error', reject);
  });
}

/** Lista partes existentes y devuelve el número de parte máximo (0 si no hay) */
function findLatestPartNumber(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir);
  let max = 0;
  for (const f of files) {
    // Formato: part-000001.ndjson
    const m = /^part-(\d{6})\.ndjson$/.exec(f);
    if (m) {
      const captured = m[1]; // string | undefined
      if (captured) {
        const n = parseInt(captured, 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
  }
  return max;
}

/** Crea nombre de archivo por parte */
function partFileName(part: number): string {
  return `part-${String(part).padStart(6, '0')}.ndjson`;
}

/** Writer NDJSON con rotación por tamaño y/o líneas, en subcarpeta dedicada */
export class RotatingNdjsonWriter {
  private dir: string;                 // p.ej. data/assignment/allIDs
  private metaPath: string;            // p.ej. data/assignment/allIDs/meta.json
  private opts: Required<RotateOptions>;
  private state: MetaState;

  constructor(targetDir: string, opts: RotateOptions = {}) {
    this.dir = targetDir;
    this.metaPath = path.join(targetDir, 'meta.json');
    this.opts = {
      maxBytesPerPart: opts.maxBytesPerPart ?? 250 * 1024 * 1024, // 250 MB
      maxLinesPerPart: opts.maxLinesPerPart ?? 500_000,           // 500k líneas
    };
    this.ensureDir();
    this.state = { part: 1, lines: 0, bytes: 0 };
  }

  /** Asegura la existencia del directorio y lo inicializa si está vacío */
  private ensureDir() {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Ruta del archivo actual (parte activa) */
  private currentPartPath(): string {
    return path.join(this.dir, partFileName(this.state.part));
  }

  /** Carga estado desde disco con preferencia por la realidad (archivos) */
  async recoverStateFromDisk() {
    // 1) Detectar última parte real
    const latest = findLatestPartNumber(this.dir);
    if (latest === 0) {
      // No hay partes: iniciamos en part=1 con archivo vacío
      this.state = { part: 1, lines: 0, bytes: 0 };
      fs.writeFileSync(this.currentPartPath(), '');
      await this.flushMeta();
      return;
    }

    // 2) Usar la última parte encontrada
    this.state.part = latest;
    const p = this.currentPartPath();

    // 3) Obtener bytes reales
    const st = fs.statSync(p);
    this.state.bytes = st.size;

    // 4) Calcular líneas reales de la última parte
    this.state.lines = await countFileLines(p);

    await this.flushMeta();
  }

  /** Guarda meta.json pequeño y consistente */
  private async flushMeta() {
    const data: MetaState = {
      part: this.state.part,
      lines: this.state.lines,
      bytes: this.state.bytes,
    };
    await fs.promises.writeFile(this.metaPath, JSON.stringify(data, null, 2), 'utf8');
  }

  /** Rotación: avanza a la siguiente parte */
  private async rotate() {
    this.state.part += 1;
    this.state.lines = 0;
    this.state.bytes = 0;
    const next = this.currentPartPath();
    if (!fs.existsSync(next)) fs.writeFileSync(next, '');
    await this.flushMeta();
  }

  private needsRotate(incomingBytes: number, incomingLines: number): boolean {
    const overBytes = (this.state.bytes + incomingBytes) > this.opts.maxBytesPerPart;
    const overLines = (this.state.lines + incomingLines) > this.opts.maxLinesPerPart;
    return overBytes || overLines;
  }

  /** Añade lote como NDJSON (una línea por objeto), con rotación automática */
  async appendBatch(objs: Record<string, unknown>[]) {
    if (!objs.length) return;

    // Serializamos sin pretty-print para ahorrar bytes
    const linesStr = objs.map(o => JSON.stringify(o)).join('\n') + '\n';
    const incomingBytes = Buffer.byteLength(linesStr, 'utf8');
    const incomingLines = objs.length;

    if (this.needsRotate(incomingBytes, incomingLines)) {
      await this.rotate();
    }

    const filePath = this.currentPartPath();
    await fs.promises.appendFile(filePath, linesStr, 'utf8');

    this.state.bytes += incomingBytes;
    this.state.lines += incomingLines;
    await this.flushMeta();
  }
}

// ---------- Requests ----------
/**
 * Envía la solicitud para una clave.
 * Incluye:
 * - Token Bearer (importado dinámicamente desde login-token.ts)
 * - Acción y clave compuesta
 */
export async function requestForKey(seq: string, index: number) {
  const fullID = fixedPrefix + seq;

  const requestBody = {
    action: 'get_list_assigned',
    id: fullID,
    requestedAt: new Date().toISOString(),
  };

  const response = await fetch('https://sag.unemi.edu.ec/api/1.0/app/revisar_cupo_asignado', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const json = await response.json();
  return { fullID, json };
}

/**
 * Reintentos exponenciales (máx 5).
 * Regresa objetos para escritura por lote (forma exacta solicitada):
 * - allIdsEntry: { [fullID]: { index, at, response } }
 * - successEntry?: { index, fullID, data, at }
 *
 * REGLA: si json.message contiene "invalid literal for int() with base 10",
 * NO reintenta (error terminal controlado).
 */
export async function requestForKeyWithBackoff(
  seq: string,
  index: number,
  attempt = 1
): Promise<{
  allIdsEntry: Record<string, unknown>;
  successEntry?: Record<string, unknown>;
}> {
  const maxAttempts = 5;

  try {
    const { fullID, json } = await requestForKey(seq, index);
    const at = new Date().toISOString();

    // Registro maestro SIEMPRE (mantener forma solicitada)
    const allIdsEntry: Record<string, unknown> = {
      [fullID]: { index, at, response: json },
    };

    // Detectar error terminal "invalid literal for int() with base 10"
    const msg: string | undefined = typeof json?.message === 'string' ? json.message : undefined;
    const hasInvalidLiteral =
      !!msg && msg.toLowerCase().includes('invalid literal for int() with base 10');

    // Caso éxito (estructura esperada)
    if (json?.data && Array.isArray(json.data.list_standby)) {
      const successEntry = {
        index,
        fullID,
        data: json.data.list_standby,
        at,
      };
      return { allIdsEntry, successEntry };
    }

    // Caso error terminal controlado: NO reintentar
    if (hasInvalidLiteral) {
      return { allIdsEntry };
    }

    // Caso "message" u otras respuestas no estándar: se considera final SIN reintento
    if (msg) {
      return { allIdsEntry };
    }

    // Respuesta inesperada sin message: reintentar con backoff
    if (attempt < maxAttempts) {
      const backoffTime = Math.pow(2, attempt) * 1000;
      await delay(backoffTime);
      return requestForKeyWithBackoff(seq, index, attempt + 1);
    }

    // agotó reintentos
    return { allIdsEntry };
  } catch (err: any) {
    // Errores de red / fetch: reintentos con backoff hasta agotar
    if (attempt < maxAttempts) {
      const backoffTime = Math.pow(2, attempt) * 1000;
      await delay(backoffTime);
      return requestForKeyWithBackoff(seq, index, attempt + 1);
    }
    // Devolver registro de error en response
    const fullID = fixedPrefix + seq;
    const allIdsEntry: Record<string, unknown> = {
      [fullID]: {
        index,
        at: new Date().toISOString(),
        response: { error: `Fallo tras ${maxAttempts} intentos: ${err?.message || String(err)}` },
      },
    };
    return { allIdsEntry };
  }
}
