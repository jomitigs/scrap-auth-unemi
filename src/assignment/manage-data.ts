// src/assignment/manage-data.ts
import path from 'node:path';
import fs from 'node:fs';
import { token } from './login-token.js';
import { assignment } from '../config/setting.js';

/** Estructura de carpetas: <project-root>/data/assignment */
export const DATA_DIR = path.join(process.cwd(), 'data', 'assignment');

// Archivos de salida
export const ALL_IDS_FILE = path.join(DATA_DIR, 'allIDs.json');       // [{ fullID: { index, at, response } }, ...]
export const SUCCESS_FILE = path.join(DATA_DIR, 'dataResults.json');  // [{ index, fullID, data, at }, ...]
export const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');    // { lastIndex }

/** Parámetros de generación de claves */
export const fixedPrefix = 'OPPQQRRSSTTUUU'; // 14 caracteres fijos
export const allowedLetters = ['M','N','O','P','Q','R','S','T','U','V','W','X','Y']; // 13 letras
export const sequenceLength = 6; // 6 letras -> total key 20 (14 + 6)

/** Concurrencia por lote declarada en settings (se asume 1000) */
export const BATCH_SIZE = Number(assignment.maxRequest) || 1000;

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

function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
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
 * Regresa objetos para escritura por lote:
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

    // Registro maestro SIEMPRE
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
