import puppeteer, { Browser, Page, CDPSession } from 'puppeteer';
import { config } from '../config/setting.js';
// @ts-ignore
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
// @ts-ignore
import puppeteerExtra from 'puppeteer-extra';

// Forzar el tipo any para evitar errores de propiedades faltantes
const puppeteerExtraAny: any = puppeteerExtra;
puppeteerExtraAny.use(StealthPlugin());

export async function createBrowser(targetUrl: string) {
  const args = [
    '--start-maximized',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-web-security',
    '--no-default-browser-check',
    '--disable-features=WindowsHello',
    '--suppress-message-center-popups',
  ];
  // Lanzar navegador con configuración de settings
  const browser: Browser = await puppeteerExtraAny.launch({ headless: config.headless, args });
  // Usar la primera página abierta por defecto
  const pages = await browser.pages();
  const page: Page = pages[0]!;

  await page.setBypassCSP(true);

  // Habilitar emulación de enfoque y omitir la CSP
  const cdpSession: CDPSession = await page.createCDPSession();
  await cdpSession.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  // User agent por CDP (recomendado)
  await cdpSession.send('Network.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    // Puedes agregar userAgentMetadata si lo necesitas
  });

  // Navegar a la URL destino
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

  // Método de cierre seguro
  async function close() {
    try {
      await page.close();
      await browser.close();
    } catch (err) {
      // Ignorar errores de cierre
    }
  }

  return { browser, page, cdpSession, close };
}
