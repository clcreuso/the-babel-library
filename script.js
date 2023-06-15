/* eslint-disable import/no-unresolved */

import Logger from './config/modules/logger.js';

import Database from './objects/Database.js';
import EPUB from './objects/interfaces/EPUB.js';

const epub = new EPUB({
  path: '/path/to/your/epub/file.epub',
  source: 'English',
  destination: 'French',
});

const write = () => {
  epub.on('writed', () => {
    setTimeout(() => process.exit(0), 5000);
  });

  epub.write();
};

const translate = () => {
  epub.on('translated', () => {
    write();
  });

  epub.translate();
};

const parse = () => {
  epub.on('parsed', () => {
    translate();
  });

  epub.parse();
};

const init = () => {
  epub.on('initiated', () => {
    parse();
  });

  epub.init();
};

(async () => {
  await Database.init();

  init();
})();

setInterval(() => Logger.info(epub.getStatus()), 5000);
