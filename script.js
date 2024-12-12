import EPUB from './objects/interfaces/EPUB.js';

import Logger from './config/logger.js';

const epub = new EPUB({
  path: process.argv[2],
});

const write = () => {
  epub.on('writed', () => {
    Logger.info('EPUB - WRITED');

    process.exit();
  });

  epub.write();
};

const summarize = () => {
  epub.on('summarized', () => {
    Logger.info('EPUB - summarized');

    write();
  });

  epub.summarize();
};

const parse = () => {
  epub.on('parsed', () => {
    Logger.info('EPUB - PARSED');

    summarize();
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
