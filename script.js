import Main from './objects/summarize/Main.js';

import Logger from './config/logger.js';

const epub = new Main({ path: process.argv[2] });

const write = () => {
  epub.on('writed', () => {
    Logger.info('EPUB - WRITED');

    process.exit();
  });

  epub.write();
};

const summarize = () => {
  epub.on('summarized', () => {
    Logger.info('EPUB - SUMMARIZED');

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
