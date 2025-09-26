export const config = {
  headless: false,
};

export const assignment = {
  username: '0954296141',
  password: 'Araqui99',

  maxRequest: 1000,

};

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export const configDir = dirname(fileURLToPath(import.meta.url));
