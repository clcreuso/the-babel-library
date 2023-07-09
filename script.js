/* eslint-disable max-len */
/* eslint-disable import/no-unresolved */

import Logger from './config/modules/logger.js';

import Database from './objects/Database.js';
import EPUB from './objects/interfaces/EPUB.js';

const epub = new EPUB({
  path: process.argv[2],
  source: 'English',
  destination: 'Français',
});

const write = () => {
  epub.on('writed', () => {
    Logger.info('EPUB - WRITED');
    setTimeout(() => process.exit(0), 5000);
  });

  epub.write();
};

const translate = () => {
  epub.on('translated', () => {
    Logger.info('EPUB - TRANSLATED');

    write();
  });

  epub.translate();
};

const parse = () => {
  epub.on('parsed', () => {
    Logger.info('EPUB - PARSED');

    translate();
  });

  epub.parse();
};

const init = () => {
  epub.on('initiated', () => {
    Logger.info('EPUB - INITIATED');

    setInterval(() => Logger.info(epub.getStatus()), 5000);

    parse();
  });

  epub.init();
};

(async () => {
  await Database.init();

  init();
})();
