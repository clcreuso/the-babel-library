/* eslint-disable import/no-unresolved */

import Logger from './config/modules/logger.js';

import EPUB from './objects/interfaces/EPUB.js';

const epub = new EPUB({
  path: '/Users/rebrain/Work/Personal/TheBabelLibrary/epubs/Chess Story.epub',
  source: 'English',
  destination: 'French',
});

const write = () => {
  epub.on('writed', () => {
    process.exit(0);
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

const extract = () => {
  epub.on('extracted', () => {
    parse();
  });

  epub.extract();
};

(() => {
  extract();
})();

setInterval(() => Logger.info(epub.getStatus()), 5000);
