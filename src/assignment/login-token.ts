// src/assignment/login-token.ts
import { assignment } from '../config/setting.js';

export let token: string | null = null;
export let refreshTokenValue: string | null = null;

/**
 * Realiza login y persiste access/refresh.
 * Permite inyectar metadatos reales del navegador.
 */
export async function login(meta?: {
  clientNavegador?: string;
  clientOS?: string;
  clientScreensize?: string;
}) {
  const body = {
    username: assignment.username,
    password: assignment.password,
    clientNavegador: meta?.clientNavegador ?? 'Chrome',
    clientOS: meta?.clientOS ?? 'Unknown OS',
    clientScreensize: meta?.clientScreensize ?? 'Unknown',
    captcha: '',
  };

  const response = await fetch('https://sag.unemi.edu.ec/api/1.0/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await response.json();
  if (!json?.access) {
    throw new Error('No se obtuvo el access token en login.');
  }

  token = json.access;
  refreshTokenValue = json.refresh || null;

  console.log('Login exitoso. Token obtenido.');
}

/**
 * Refresca el token usando el refresh token actual.
 * Si la API retorna también un nuevo refresh, lo actualiza; si no, conserva el anterior.
 */
export async function refreshToken() {
  if (!refreshTokenValue) {
    console.warn('No hay refresh token disponible para refrescar.');
    return;
  }

  const response = await fetch('https://sag.unemi.edu.ec/api/1.0/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh: refreshTokenValue }),
  });

  const json = await response.json();
  if (!json?.access) {
    throw new Error('Fallo al refrescar el token.');
  }

  token = json.access;
  refreshTokenValue = json.refresh || refreshTokenValue;

  console.log('Token refrescado exitosamente.');
}
