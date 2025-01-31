import Summarize from './objects/summarize/Main.js';
import Rewrite from './objects/rewrite/interfaces/EPUB.js';
import Translate from './objects/translate/interfaces/EPUB.js';

import Logger from './config/logger.js';

const getEpub = () => {
  if (process.argv[2] === '-r') return new Rewrite({ path: process.argv[3] });

  if (process.argv[2] === '-t') return new Translate({ path: process.argv[3] });

  if (process.argv[2] === '-s') return new Summarize({ path: process.argv[3] });

  return new Translate({ path: process.argv[3] });
};

const epub = getEpub();

const write = () => {
  epub.on('writed', () => {
    Logger.info('EPUB - WRITED');

    process.exit();
  });

  epub.write();
};

const launch = () => {
  epub.on('processed', () => {
    Logger.info('EPUB - PROCESSED');

    write();
  });

  epub.process();
};

const parse = () => {
  epub.on('parsed', () => {
    Logger.info('EPUB - PARSED');

    launch();
  });

  epub.parse();
};

const init = () => {
  epub.on('initiated', () => {
    Logger.info('EPUB - INITIATED');

    setInterval(() => Logger.info(epub.getStatus()), 1000);

    parse();
  });

  epub.init();
};

(async () => {
  init();
})();
